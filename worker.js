/**
 * Vivo Refurbished Category 53 — PRO v12
 * ✅ Stok READY jika tombol "Beli Sekarang" bisa diklik
 * ✅ KV tracking, Telegram notify, Cron, Test mode
 */

const CATEGORY_ID = 53;
const LIST_URL = `https://shop.vivo.com/id/products/phone?categoryId=${CATEGORY_ID}`;
const SEARCH_API = (k) =>
  `https://shop.vivo.com/api/v3/product/search?keyword=${encodeURIComponent(k)}&page=1&pageSize=6&platform=1&channel=UTF-8&country=ID`;

// === TELEGRAM CONFIG ===
const TG_TOKEN = "8322901606:AAHrCt-ODhFqlC0ZIQSf0WL8WlUvwSJeYeU";
const TG_CHAT = "253407101";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      return json(await runJob(env, request));
    }
    return json({ ok: true, message: "Vivo Checker PRO v12 ✅" });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runJob(env, new Request("https://cron-trigger")));
  }
};

async function runJob(env, request) {
  if (!env?.STORE) {
    return { ok: false, error: "❌ KV Binding STORE belum terhubung!" };
  }

  const url = new URL(request.url);
  const testMode = url.searchParams.get("test");

  const html = await fetchHtml(LIST_URL);
  const basic = listBasic(html);
  const list = await fullEnrich(basic);

  if (testMode === "ready") {
    const readyItems = list.filter((x) => x.stockLabel === "Tersedia");
    return {
      ok: true,
      test: "ready_only",
      ready_count: readyItems.length,
      items: readyItems.length ? readyItems : list.slice(0, 5)
    };
  }

  if (!list.length) {
    return { ok: false, error: "Tidak ada produk ditemukan 🚫" };
  }

  const changes = [];
  for (const p of list) {
    const idKey = slug(p.name);
    const oldPrice = await env.STORE.get(`${idKey}_price`, "json");
    const oldStock = await env.STORE.get(`${idKey}_stock`, "text");

    const isNew = oldPrice === null && oldStock === null;
    const priceDrop = oldPrice !== null && p.salePrice != null && p.salePrice < oldPrice;
    const restock = oldStock && oldStock !== "Tersedia" && p.stockLabel === "Tersedia";

    if (isNew || priceDrop || restock) {
      changes.push({
        event: isNew ? "NEW" : priceDrop ? "PRICE_DROP" : "RESTOCK",
        product: p
      });
      await sendTG(formatMsg(isNew, priceDrop, restock, p));
    }

    await env.STORE.put(`${idKey}_price`, JSON.stringify(p.salePrice ?? 0));
    await env.STORE.put(`${idKey}_stock`, p.stockLabel);
  }

  return {
    ok: true,
    scraped: list.length,
    notif: changes.length,
    notifications: changes
  };
}

/* ================= ENRICH ================= */
async function fullEnrich(list) {
  const out = [];
  for (const b of list) {
    const det = await fetchJson(SEARCH_API(b.name));
    const best = det?.data?.list?.[0] || {};

    const sale = norm(best.salePrice ?? b.salePrice);
    const orig = norm(best.originalPrice ?? b.originalPrice);
    const discount =
      orig && sale && orig > sale ? Math.round(((orig - sale) / orig) * 100) : (b.discount ?? 0);

    out.push({
      name: b.name,
      salePrice: sale,
      originalPrice: orig,
      discount,
      stockLabel: b.stockLabel,
      spuId: best.spuId ?? null,
      url: best.spuId ? `https://shop.vivo.com/id/product/${best.spuId}` : LIST_URL
    });
  }
  return out;
}

/* ================= HTML PARSER ================= */
function listBasic(html) {
  const arr = [];
  const blockRe = /<div class="goods-item"[\s\S]*?<\/div>\s*<\/div>/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const block = m[0];

    const name = pick(block, /<h3[^>]*>([^<]+)<\/h3>/i);
    if (!name) continue;

    const saleRaw = pick(block, /<span class="price-num"[^>]*>([\d\.]+)/i);
    const origRaw = pick(block, /<span class="old"[^>]*>Rp\s?([\d\.]+)/i);
    const discRaw = pick(block, /<span class="off"[^>]*>-(\d+)%/i);

    const stockLabel = detectBuyButton(block) ? "Tersedia" : "Habis";

    arr.push({
      name: name.trim(),
      salePrice: num(saleRaw),
      originalPrice: num(origRaw),
      discount: discRaw ? Number(discRaw) : 0,
      stockLabel
    });
  }
  return arr;
}

function detectBuyButton(html) {
  const btnRe = /<(a|button)[^>]*>[\s\S]{0,200}?Beli\s*Sekarang[\s\S]{0,200}?<\/\1>/gi;
  const btn = btnRe.exec(html);
  if (!btn) return false;
  const open = (btn[0].match(/^<(a|button)[^>]*>/i) || [""])[0];
  return !/(disabled|is-disabled|btn-disabled|aria-disabled="true"|href="#")/i.test(open);
}

/* ================= HELPERS ================= */
function pick(s, re) { const m = s.match(re); return m ? m[1] : null; }
const num = (s) => (s ? Number(s.replace(/\./g, "")) : null);
const norm = (n) => (Number.isFinite(Number(n)) ? Number(n) : null);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const fmt = (n) => `Rp${Number(n).toLocaleString("id-ID")}`;

function formatMsg(isNew, priceDrop, restock, p) {
  const title = isNew ? "🆕 Baru!" : priceDrop ? "🔥 Harga Turun!" : "✅ Restock!";
  return `${title}
${p.name}
💰 ${fmt(p.salePrice)}
📦 ${p.stockLabel}
🔗 ${p.url}`;
}

async function fetchHtml(url) { return await (await fetch(url)).text(); }
async function fetchJson(url) { try { return await (await fetch(url)).json(); } catch { return null; } }
async function sendTG(text) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text })
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
