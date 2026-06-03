import { getUser, requireAuth, json } from "../../_lib/auth.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const user = await getUser(request, env);
  const err  = requireAuth(user);
  if (err) return err;

  // 세목별 질문·답변 집계
  const { results: byCategory } = await env.DB.prepare(`
    SELECT
      q.tax_category,
      COUNT(q.id)                                   AS question_count,
      SUM(CASE WHEN q.status = 'done'  THEN 1 ELSE 0 END) AS answered_count,
      SUM(CASE WHEN q.status = 'error' THEN 1 ELSE 0 END) AS error_count,
      SUM(CASE WHEN a.content_edited IS NOT NULL THEN 1 ELSE 0 END) AS edited_count,
      MAX(q.created_at)                             AS last_question_at
    FROM questions q
    LEFT JOIN answers a ON a.question_id = q.id
    ${user.role !== "admin" ? "WHERE q.user_id = ?" : ""}
    GROUP BY q.tax_category
    ORDER BY question_count DESC
  `).bind(...(user.role !== "admin" ? [user.id] : [])).all();

  // 일별 질문 추이 (최근 30일)
  const { results: byDate } = await env.DB.prepare(`
    SELECT
      DATE(q.created_at) AS date,
      COUNT(q.id)        AS question_count,
      q.tax_category
    FROM questions q
    WHERE q.created_at >= DATE('now', '-30 days')
    ${user.role !== "admin" ? "AND q.user_id = ?" : ""}
    GROUP BY DATE(q.created_at), q.tax_category
    ORDER BY date DESC
  `).bind(...(user.role !== "admin" ? [user.id] : [])).all();

  // 전체 요약
  const { results: [summary] } = await env.DB.prepare(`
    SELECT
      COUNT(q.id)                                              AS total_questions,
      SUM(CASE WHEN q.status = 'done' THEN 1 ELSE 0 END)      AS total_answered,
      SUM(CASE WHEN a.content_edited IS NOT NULL THEN 1 ELSE 0 END) AS total_edited,
      COUNT(DISTINCT q.tax_category)                           AS active_categories
    FROM questions q
    LEFT JOIN answers a ON a.question_id = q.id
    ${user.role !== "admin" ? "WHERE q.user_id = ?" : ""}
  `).bind(...(user.role !== "admin" ? [user.id] : [])).all();

  return json({ summary, by_category: byCategory, by_date: byDate });
}
