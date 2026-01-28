import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import cron from "node-cron";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing");

const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
const TZ = process.env.TZ || "Asia/Seoul";
const MEETING_TIME = "21:00"; // uchrashuv boshlanish vaqti
const AUTO_SUMMARY_AFTER_MS = 5 * 60 * 1000; // 5 daqiqa

const bot = new Telegraf(BOT_TOKEN);

/* ================== STATE (xotirada) ================== */
type Answer = "yes" | "no";
type UserAnswer = { answer: Answer; name: string };

let answers = new Map<number, UserAnswer>();
let sessionActive = false;
let autoSummaryTimer: NodeJS.Timeout | null = null;

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

function buildResultsText() {
  const yesNames: string[] = [];
  const noNames: string[] = [];

  for (const v of answers.values()) {
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

function buildShortResult() {
  const yes = [...answers.values()].filter((x) => x.answer === "yes").length;
  const no = [...answers.values()].filter((x) => x.answer === "no").length;
  return `✅ Tayyor: ${yes} | ❌ Tayyor emas: ${no} | Jami: ${yes + no}`;
}

async function sendMeetingQuestion(chatId: string | number) {
  answers.clear();
  sessionActive = true;

  // eski timer bo‘lsa o‘chirib qo‘yamiz
  if (autoSummaryTimer) clearTimeout(autoSummaryTimer);

  await bot.telegram.sendMessage(
    chatId,
    "🕘 Uchrashuvga 10 daqiqa qoldi.\nTayyormisiz?",
    Markup.inlineKeyboard([
      Markup.button.callback("✅ Tayyor", "MEET_YES"),
      Markup.button.callback("❌ Tayyor emas", "MEET_NO"),
      Markup.button.callback("📊 Natija", "MEET_RESULT"),
    ]),
  );

  // 5 daqiqadan keyin avtomatik natija
  autoSummaryTimer = setTimeout(async () => {
    try {
      if (!sessionActive) return;
      await bot.telegram.sendMessage(
        chatId,
        `⏱ 5 daqiqa o‘tdi.\n${buildShortResult()}\n\n/results — to‘liq ro‘yxat`,
      );
    } catch (err) {
      console.error("Auto summary error:", err);
    }
  }, AUTO_SUMMARY_AFTER_MS);
}

/* ================== COMMANDS ================== */
bot.start(async (ctx) => {
  await ctx.reply(
    "Salom! Tayyorvoy xizmatinizda!👋\n\n" +
      "/where — chat ID\n" +
      "/ready — savolni hozir tashlash\n" +
      "/results — natija + ismlar\n" +
      "/stop — sessionni yopish (ixtiyoriy)",
  );
});

bot.command("where", async (ctx) => {
  await ctx.reply(`Chat ID: ${ctx.chat.id}`);
});

bot.command("ready", async (ctx) => {
  await sendMeetingQuestion(ctx.chat.id);
});

bot.command("results", async (ctx) => {
  if (!sessionActive) {
    await ctx.reply("Hozir aktiv savol yo‘q.");
    return;
  }
  await ctx.reply(buildResultsText());
});

bot.command("stop", async (ctx) => {
  sessionActive = false;
  answers.clear();
  if (autoSummaryTimer) clearTimeout(autoSummaryTimer);
  autoSummaryTimer = null;
  await ctx.reply("✅ Session yopildi.");
});

/* ================== BUTTONS ================== */
bot.action("MEET_YES", async (ctx) => {
  if (!ctx.from) return;
  if (!sessionActive) return ctx.answerCbQuery("Hozir aktiv savol yo‘q.");

  const name = userDisplayName(ctx.from);
  answers.set(ctx.from.id, { answer: "yes", name });

  await ctx.answerCbQuery("✅ Qabul qilindi");
});

bot.action("MEET_NO", async (ctx) => {
  if (!ctx.from) return;
  if (!sessionActive) return ctx.answerCbQuery("Hozir aktiv savol yo‘q.");

  const name = userDisplayName(ctx.from);
  answers.set(ctx.from.id, { answer: "no", name });

  await ctx.answerCbQuery("❌ Qabul qilindi");
});

bot.action("MEET_RESULT", async (ctx) => {
  if (!sessionActive) return ctx.answerCbQuery("Natija yo‘q.");
  await ctx.answerCbQuery(buildShortResult());
});

/* ================== SCHEDULE ==================
   Tue(2), Thu(4), Sat(6)
   21:00 dan 10 daqiqa oldin => 20:50
================================================ */
function setupSchedule() {
  if (!GROUP_CHAT_ID) {
    console.log("GROUP_CHAT_ID yo‘q. /where orqali oling va .env ga yozing");
    return;
  }

  const [hh, mm] = MEETING_TIME.split(":").map(Number);
  const totalMinutes = hh * 60 + mm - 10;

  const sendHour = Math.floor(((totalMinutes + 1440) % 1440) / 60);
  const sendMinute = (totalMinutes + 1440) % 60;

  const cronExpr = `${sendMinute} ${sendHour} * * 2,4,6`; // Tue,Thu,Sat
  // const cronExpr = "*/1 * * * *"; // test uchun: har minut

  console.log("Schedule:", cronExpr, "TZ:", TZ);

  cron.schedule(
    cronExpr,
    async () => {
      try {
        await sendMeetingQuestion(GROUP_CHAT_ID);
      } catch (err) {
        console.error("Schedule error:", err);
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
