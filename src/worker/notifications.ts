import type { Preference, Schedule } from '../shared/model'
import { inPeriod, instant, localDate, shiftDate, timeline } from '../shared/time'
import { schedule, type Env } from './core'
import { dayText, send, TelegramError } from './telegram'

interface Job { user_id: string; event: string; group_id: string; message: string }
async function queue(env: Env, group: string, preference: Preference, key: string, message: string, now: number, expires: number, version?: number) {
  // The column name comes from a closed union supplied by the scheduler.
  await env.DB.prepare(`INSERT OR IGNORE INTO notification_jobs(user_id,event,group_id,message,due,expires)
    SELECT id,?,group_id,?,?,? FROM users WHERE group_id=? AND private_chat=1 AND blocked=0 AND ${preference}=1
    AND (? IS NULL OR seen_version < ?)
    AND NOT EXISTS (SELECT 1 FROM group_notification_disabled WHERE group_id=users.group_id AND kind=?)`)
    .bind(`${preference}:${group}:${key}`, message.slice(0, 4000), now, expires, group, version ?? null, version ?? null, preference).run()
}
export function notificationWindow(data: Schedule, now: number) {
  const date = localDate(now)
  const within = (time: string) => now >= instant(date, time) && now < instant(date, time) + 1800000
  const reminder = timeline(data.lessons.filter(l => l.date === date), data.holidays)
    .find(t => t.start >= now + 10 * 60000 && t.start < now + 15 * 60000)
  return { date, morning: within('07:00'), evening: within('19:00'), reminder }
}
export async function processNotifications(env: Env, now: number) {
  if (!env.BOT_TOKEN) return
  const db = env.DB
  const groups = (await db.prepare(`SELECT DISTINCT group_id FROM users WHERE private_chat=1 AND blocked=0
    AND (changes OR evening OR morning OR reminder) ORDER BY group_id`).all<{ group_id: string }>()).results
  // Keep each invocation bounded by the Workers Free subrequest budget.
  const group = groups[Math.floor(now / 300000) % groups.length]?.group_id
  if (group) {
    const today = localDate(now), tomorrow = shiftDate(today, 1)
    const data = await schedule(db, group, today, tomorrow)
    const { morning, evening, reminder } = notificationWindow(data, now)
    if (data.version && data.updated && now - Date.parse(data.updated) < 86400000)
      await queue(env, group, 'changes', String(data.version), `${group}: опубликована версия расписания v${data.version}`, now, Date.parse(data.updated) + 86400000, data.version)
    if (morning && inPeriod(today, data.periods))
      await queue(env, group, 'morning', today, dayText(data, today), now, instant(today, '09:00'))
    if (evening && inPeriod(tomorrow, data.periods))
      await queue(env, group, 'evening', tomorrow, dayText(data, tomorrow), now, instant(today, '22:00'))
    if (reminder)
      await queue(env, group, 'reminder', String(reminder.start), `Скоро занятие: ${reminder.lesson.title}\n${[reminder.lesson.room, reminder.lesson.building].filter(Boolean).join(' · ')}`, now, reminder.start)
  }
  const jobs = (await db.prepare(`SELECT j.* FROM notification_jobs j JOIN users u ON u.id=j.user_id AND u.group_id=j.group_id
    WHERE j.state='pending' AND j.due<=? AND j.expires>? AND NOT u.blocked AND u.private_chat
    AND NOT EXISTS (SELECT 1 FROM group_notification_disabled d WHERE d.group_id=j.group_id AND d.kind=substr(j.event,1,instr(j.event,':')-1)) AND
    CASE substr(j.event,1,instr(j.event,':')-1) WHEN 'changes' THEN u.changes WHEN 'morning' THEN u.morning
    WHEN 'evening' THEN u.evening WHEN 'reminder' THEN u.reminder END
    ORDER BY j.expires LIMIT 12`).bind(now, now).all<Job>()).results
  for (const job of jobs) {
    const claimed = await db.prepare("UPDATE notification_jobs SET state='claimed' WHERE user_id=? AND event=? AND state='pending' RETURNING event")
      .bind(job.user_id, job.event).first()
    if (!claimed) continue
    try {
      await send(env, job.user_id, job.message)
    } catch (err) {
      if (!(err instanceof TelegramError) || err.reason !== 'rejected') continue
      if (err.code === 403)
        await db.prepare('UPDATE users SET blocked=1 WHERE id=?').bind(job.user_id).run()
      if (err.code === 429) {
        await db.prepare("UPDATE notification_jobs SET state='pending',due=? WHERE user_id=? AND event=?")
          .bind(now + Math.max(1, err.retryAfter) * 1000, job.user_id, job.event).run()
        break
      }
    }
  }
  if (Math.floor(now / 300000) % 12 === 0) {
    await db.batch([
      db.prepare('DELETE FROM rate_limits WHERE bucket < ?').bind(Math.floor(now / 60000) - 120),
      db.prepare('DELETE FROM telegram_files WHERE created < ?').bind(now - 86400000),
      db.prepare('DELETE FROM telegram_updates WHERE processed_at < ?').bind(now - 7 * 86400000),
      db.prepare('DELETE FROM notification_jobs WHERE expires < ?').bind(now - 2 * 86400000),
      db.prepare('DELETE FROM imports WHERE created < ? AND NOT EXISTS (SELECT 1 FROM versions WHERE draft_id=imports.id)').bind(now - 86400000),
    ])
  }
}
