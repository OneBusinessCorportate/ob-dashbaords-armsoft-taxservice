// =============================================================================
// Edge Function: artyom-export-notice
//
// Ежедневная отбивка в Telegram о статусе выгрузки Артёма. Дёргает SQL-функцию
// public.artyom_export_schedule_status() (единый источник статуса — тот же, что
// показывает дашборд) и отправляет сообщение с одним из 4 статусов:
//   ⏳ Ожидаем выгрузку · ✅ Выгрузил · ⚠️ Просрочено · ⚫ Нет данных
//
// СЕКРЕТЫ — только в переменных окружения (Supabase → Edge Functions → Secrets),
// в код/репозиторий не попадают:
//   TELEGRAM_BOT_TOKEN   — токен бота (обязателен для реальной отправки)
//   TELEGRAM_CHAT_ID     — чат/канал назначения (обязателен для отправки)
//   NOTICE_SECRET        — (опц.) общий секрет; если задан, запрос обязан
//                          прислать заголовок x-notice-secret с тем же значением
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — подставляются рантаймом автоматически
//
// Без TELEGRAM_* функция работает в режиме «dry run»: возвращает сформированное
// сообщение в теле ответа (удобно для проверки без секретов).
//
// Запуск по расписанию: настройте Scheduled Function / cron на нужный час
// (после дедлайна выгрузки), например ежедневно.
// =============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

type StatusRow = {
  status: "awaiting" | "exported" | "overdue" | "no_data";
  last_run: string | null;
  expected_by: string | null;
  grace_until: string | null;
  hours_late: number | null;
  now_yerevan: string | null;
  active_modules: number | null;
  last_run_modules: number | null;
};

// Зеркало config.js → TASK_SYNC.scheduleStatuses (подписи 4 статусов)
const STATUS_LABELS: Record<string, { label: string; emoji: string }> = {
  awaiting: { label: "Ожидаем выгрузку", emoji: "⏳" },
  exported: { label: "Выгрузил", emoji: "✅" },
  overdue: { label: "Просрочено", emoji: "⚠️" },
  no_data: { label: "Нет данных", emoji: "⚫" },
};

const TZ = "Asia/Yerevan";

function fmt(dt: string | null): string {
  if (!dt) return "—";
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: TZ,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(dt));
  } catch {
    return String(dt);
  }
}

function buildMessage(s: StatusRow): string {
  const meta = STATUS_LABELS[s.status] ?? STATUS_LABELS.no_data;
  const lines = [
    `${meta.emoji} Выгрузка Артёма: ${meta.label}`,
    "",
    `Последняя выгрузка: ${fmt(s.last_run)}`,
    `Ожидалась к: ${fmt(s.expected_by)}`,
  ];
  if (s.status === "overdue" && s.hours_late) {
    lines.push(`Опоздание: ${s.hours_late} ч`);
  }
  if (s.status === "awaiting") {
    lines.push(`Крайний срок (с учётом льготного периода): ${fmt(s.grace_until)}`);
  }
  if (s.active_modules != null) {
    lines.push(
      `Модулей активно: ${s.active_modules}` +
        (s.last_run_modules != null ? ` · в последней выгрузке: ${s.last_run_modules}` : ""),
    );
  }
  lines.push("", `Проверено: ${fmt(s.now_yerevan)} (Ереван)`);
  return lines.join("\n");
}

async function fetchStatus(url: string, key: string): Promise<StatusRow> {
  const resp = await fetch(`${url}/rest/v1/v_artyom_export_status?select=*`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!resp.ok) {
    throw new Error(`status query failed: ${resp.status} ${await resp.text()}`);
  }
  const rows = (await resp.json()) as StatusRow[];
  if (!rows.length) throw new Error("v_artyom_export_status returned no rows");
  return rows[0];
}

async function sendTelegram(token: string, chatId: string, text: string): Promise<unknown> {
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  const data = await resp.json();
  if (!resp.ok || !data.ok) throw new Error(`telegram send failed: ${JSON.stringify(data)}`);
  return data;
}

Deno.serve(async (req: Request) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  try {
    // опциональная защита общим секретом
    const noticeSecret = Deno.env.get("NOTICE_SECRET");
    if (noticeSecret && req.headers.get("x-notice-secret") !== noticeSecret) {
      return json({ error: "unauthorized" }, 401);
    }

    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return json({ error: "SUPABASE_URL / SERVICE_ROLE not configured" }, 500);

    const status = await fetchStatus(url, key);
    const message = buildMessage(status);

    const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
    const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
    if (!token || !chatId) {
      // dry run — секреты не заданы, просто возвращаем сообщение
      return json({ sent: false, dry_run: true, status: status.status, message });
    }

    const tg = await sendTelegram(token, chatId, message);
    return json({ sent: true, status: status.status, message, telegram: tg });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
