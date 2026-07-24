// Telegram alerts using the built-in fetch (no extra dependency).
// Credentials come from the environment (loaded from .env by src/scan.js).
import { promises as fs } from "node:fs";

function creds() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error(
      "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID. Copy .env.example to .env and fill them in."
    );
  }
  return { token, chatId };
}

// Never let the bot token appear in logs.
export function redact(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return text;
  return String(text).split(token).join("<redacted-token>");
}

export async function sendMessage(text) {
  const { token, chatId } = creds();
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false }),
  });
  if (!res.ok) {
    throw new Error(redact(`Telegram sendMessage failed: ${res.status} ${await res.text()}`));
  }
}

// Send a screenshot file with a caption.
export async function sendPhoto(imagePath, caption) {
  const { token, chatId } = creds();
  const bytes = await fs.readFile(imagePath);
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", caption);
  form.append("photo", new Blob([bytes], { type: "image/png" }), "seatmap.png");

  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    throw new Error(redact(`Telegram sendPhoto failed: ${res.status} ${await res.text()}`));
  }
}

// One helper the scan uses: caption + photo if we have a screenshot, else text.
export async function alert({ caption, imagePath }) {
  if (imagePath) {
    await sendPhoto(imagePath, caption);
  } else {
    await sendMessage(caption);
  }
}
