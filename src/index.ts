import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import cron from "node-cron";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing");

const TZ = process.env.TZ || "Asia/Seoul";

// Если хочешь расписание только для одной группы:
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID
  ? Number(process.env.GROUP_CHAT_ID)
  : null;

const MEETING_TIME = "21:00"; // boshlanish vaqti
const SESSION_MS = 15 * 60 * 1000; // 15 minut

const bot = new Telegraf(BOT_TOKEN);

/* ================== STATE (per chat) ================== */
type Answer = "yes" | "no";
type UserAnswer = { answer: Answer; name: string };

type Session = {
  active: boolean;
  answers: Map<number, UserAnswer>; // userId -> {answer, name} (ALOHIDA har bir guruh uchun)
  closeTimer: NodeJS.Timeout | null;
  messageId: number | null; // savol yuborilgan xabar id (edit qilish uchun)
};

const sessions = new Map<number, Session>();

function getSession(chatId: number): Session {
  let s = sessions.get(chatId);
  if (!s) {
    s = {
      active: false,
      answers: new Map(),
      closeTimer: null,
      messageId: null,
    };
    sessions.set(chatId, s);
  }
  return s;
}

/* ================== HELPERS ================== */
function userDisplayName(from: {
  first_name?: string;
  last_name?: string;
  username?: string;
}) {
  const full = [from.first_name, from.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (full) return full;
  if (from.username) return `@${from.username}`;
  return "Unknown";
}

function formatUserList(list: string[]) {
  if (list.length === 0) return "—";
  return (
    list
      .slice(0, 30)
      .map((n, i) => `${i + 1}) ${n}`)
      .join("\n") + (list.length > 30 ? `\n... +${list.length - 30}` : "")
  );
}

function buildResultsText(chatId: number) {
  const s = getSession(chatId);

  const yesNames: string[] = [];
  const noNames: string[] = [];

  for (const v of s.answers.values()) {
    if (v.answer === "yes") yesNames.push(v.name);
    else noNames.push(v.name);
  }

  yesNames.sort((a, b) => a.localeCompare(b));
  noNames.sort((a, b) => a.localeCompare(b));

  const yes = yesNames.length;
  const no = noNames.length;
  const total = yes + no;

  return (
    `📊 Natija:\n` +
    `✅ Tayyor: ${yes}\n` +
    `❌ Tayyor emas: ${no}\n` +
    `Jami: ${total}\n\n` +
    `✅ Tayyor bo‘lganlar:\n${formatUserList(yesNames)}\n\n` +
    `❌ Tayyor emaslar:\n${formatUserList(noNames)}`
  );
}

function buildShortResult(chatId: number) {
  const s = getSession(chatId);
  let yes = 0,
    no = 0;
  for (const v of s.answers.values()) {
    if (v.answer === "yes") yes++;
    else no++;
  }
  return `✅ ${yes} | ❌ ${no} | Jami ${yes + no}`;
}

function keyboard(active: boolean) {
  if (!active) return Markup.inlineKeyboard([]);
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("✅ Tayyor", "MEET_YES"),
      Markup.button.callback("❌ Tayyor emas", "MEET_NO"),
    ],
    [
      Markup.button.callback("🔄 Bekor qilish", "MEET_CANCEL"),
      Markup.button.callback("📊 Natija", "MEET_RESULT"),
    ],
  ]);
}

/* ================== SESSION CONTROL ================== */
async function closeSession(chatId: number) {
  const s = getSession(chatId);
  if (!s.active) return;

  s.active = false;
  if (s.closeTimer) clearTimeout(s.closeTimer);
  s.closeTimer = null;

  const text = `⛔ Session tugadi (15 minut o‘tdi).\n\n${buildResultsText(chatId)}`;

  // убираем кнопки через edit
  if (s.messageId) {
    try {
      await bot.telegram.editMessageText(chatId, s.messageId, undefined, text, {
        reply_markup: keyboard(false).reply_markup,
      });
      return;
    } catch {
      // если edit не сработал — просто отправим новый итог
    }
  }

  await bot.telegram.sendMessage(chatId, text);
}

async function startSession(chatId: number) {
  const s = getSession(chatId);

  // если уже была активная — закрываем старую и начинаем новую
  if (s.active) await closeSession(chatId);

  s.answers.clear();
  s.active = true;

  const msg: any = await bot.telegram.sendMessage(
    chatId,
    "🕘 Uchrashuvga 10 daqiqa qoldi.\nTayyormisiz?",
    keyboard(true),
  );

  s.messageId = msg?.message_id ?? null;

  if (s.closeTimer) clearTimeout(s.closeTimer);
  s.closeTimer = setTimeout(() => {
    void closeSession(chatId);
  }, SESSION_MS);
}

/* ================== COMMANDS ================== */
bot.start(async (ctx) => {
  await ctx.reply(
    "Salom! Meeting Ready Bot ishlayapti 👋\n\n" +
      "/where — chat ID\n" +
      "/ready — sessionni hozir boshlash\n" +
      "/results — natija + ismlar (faqat shu guruh uchun)\n",
  );
});

bot.command("where", async (ctx) => {
  await ctx.reply(`Chat ID: ${ctx.chat.id}`);
});

bot.command("ready", async (ctx) => {
  if (ctx.chat.type === "private")
    return ctx.reply("Bu buyruq faqat guruhda ishlaydi.");
  await startSession(ctx.chat.id);
});

bot.command("results", async (ctx) => {
  if (ctx.chat.type === "private")
    return ctx.reply("Bu buyruq faqat guruhda ishlaydi.");

  const s = getSession(ctx.chat.id);
  if (!s.active) return ctx.reply("Hozir aktiv session yo‘q.");

  await ctx.reply(buildResultsText(ctx.chat.id));
});

/* ================== BUTTONS ================== */
bot.action("MEET_YES", async (ctx) => {
  if (!ctx.from) return;
  const chatId = ctx.chat?.id;
  if (typeof chatId !== "number") return;

  const s = getSession(chatId);
  if (!s.active) return ctx.answerCbQuery("Session tugagan.");

  const name = userDisplayName(ctx.from);
  s.answers.set(ctx.from.id, { answer: "yes", name });

  await ctx.answerCbQuery("✅ Qabul qilindi");
});

bot.action("MEET_NO", async (ctx) => {
  if (!ctx.from) return;
  const chatId = ctx.chat?.id;
  if (typeof chatId !== "number") return;

  const s = getSession(chatId);
  if (!s.active) return ctx.answerCbQuery("Session tugagan.");

  const name = userDisplayName(ctx.from);
  s.answers.set(ctx.from.id, { answer: "no", name });

  await ctx.answerCbQuery("❌ Qabul qilindi");
});

bot.action("MEET_CANCEL", async (ctx) => {
  if (!ctx.from) return;
  const chatId = ctx.chat?.id;
  if (typeof chatId !== "number") return;

  const s = getSession(chatId);
  if (!s.active) return ctx.answerCbQuery("Session tugagan.");

  if (!s.answers.has(ctx.from.id))
    return ctx.answerCbQuery("Siz hali ovoz bermagansiz.");
  s.answers.delete(ctx.from.id);

  await ctx.answerCbQuery("🔄 Bekor qilindi");
});

bot.action("MEET_RESULT", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (typeof chatId !== "number") return;

  const s = getSession(chatId);
  if (!s.active) return ctx.answerCbQuery("Session tugagan.");

  await ctx.answerCbQuery(buildShortResult(chatId));
});

/* ================== SCHEDULE (1 group from env) ================== */
function setupSchedule() {
  if (!GROUP_CHAT_ID) {
    console.log("GROUP_CHAT_ID yo‘q — cron faqat /ready bilan ishlaydi");
    return;
  }

  // ВТ, СР, ЧТ, ПТ, СБ → 20:50 (за 10 мин до 21:00)
  const weekdayCron = "50 20 * * 2-6";

  // ВОСКРЕСЕНЬЕ → 19:20 (за 10 мин до 19:30)
  const sundayCron = "20 19 * * 0";

  console.log("Schedule weekday:", weekdayCron, "TZ:", TZ);
  console.log("Schedule sunday:", sundayCron, "TZ:", TZ);

  cron.schedule(
    weekdayCron,
    async () => {
      try {
        await startSession(GROUP_CHAT_ID);
      } catch (err) {
        console.error("Weekday schedule error:", err);
      }
    },
    { timezone: TZ },
  );

  cron.schedule(
    sundayCron,
    async () => {
      try {
        await startSession(GROUP_CHAT_ID);
      } catch (err) {
        console.error("Sunday schedule error:", err);
      }
    },
    { timezone: TZ },
  );
}

setupSchedule();

/* ================== LAUNCH ================== */
bot.launch();
console.log("Bot started");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
