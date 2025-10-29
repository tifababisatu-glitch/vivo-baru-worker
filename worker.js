/**
 * Vivo Refurbished Category 53 — PRO v10
 * Direct Upload Version (tanpa wrangler.toml pada deploy manual)
 * Required KV Binding Name: STORE
 */

const CATEGORY_ID = 53;
const LIST_URL = `https://shop.vivo.com/id/products/phone?categoryId=${CATEGORY_ID}`;
const SEARCH_API = k =>
  `https://shop.vivo.com/api/v3/product/search?keyword=${encodeURIComponent(k)}&page=1&pageSize=6&platform=1&channel=UTF-8&country=ID`;

// === TELEGRAM CONFIG ===
const TG_TOKEN = "8322901606:AAHrCt-ODhFqlC0ZIQSf0WL8WlUvwSJeYeU";
const TG_CHAT = "253407101";


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      return json(await runJob(env));
    }
    return json({ ok: true, message: "Vivo Checker PRO v10 Ready ✅" });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runJob(env));
  }
};

async function runJob(env) {
  if (!env?.STORE) {
    return { ok: false, error: "❌ KV Binding STORE belum terhubung!" };
  }

  const html = await fetchHtml(LIST_URL);
  const list = parseProducts(html);

  if (!list.length) {
    return { ok: false, error: "Produk tidak ditemukan 🚫" };
  }

  const results = [];
  for (const item of list) {
    const det = await fetchJson(SEARCH_API(item.name));
    const best = det?.data?.list?.[0] || {};

    const sale = normNum(best.salePrice ?? item.salePrice);
    const orig = normNum(best.originalPrice ?? item.originalPrice);
    const discount = (orig > sale) ? Math.floor(((orig-sale)/orig)*100) : item.discount;

    let stock = "Habis";
    if (best.skuList?.[0]?.stockStatus === 1) stock = "Tersedia";
    if (best?.canBuy) stock = "Tersedia";

    const p = {
      name: item.name,
      salePrice: sale,
      originalPrice: orig,
      discount,
      stockLabel: stock,
      spuId: best.spuId || null,
      url: best.spuId
        ? `https://shop.vivo.com/id/product/${best.spuId}`
        : LIST_URL,
    };

    results.push(p);
  }

  const notifications = [];
  for (const p of results) {
    const idKey = slug(p.name);
    const oldPrice = await env.STORE.get(`${idKey}_price`, "json");
    const oldStock = await env.STORE.get(`${idKey}_stock`, "text");

    const isNew = oldPrice === null && oldStock === null;
    const priceDrop = oldPrice && p.salePrice < oldPrice;
    const restock = oldStock && oldStock !== "Tersedia" && p.stockLabel === "Tersedia";

    if (isNew || priceDrop || restock) {
      notifications.push({ event: isNew ? "NEW" : priceDrop ? "PRICE_DROP" : "RESTOCK", product: p });

      await sendTG(formatMsg(isNew, priceDrop, restock, p));
    }

    await env.STORE.put(`${idKey}_price`, JSON.stringify(p.salePrice ?? 0));
    await env.STORE.put(`${idKey}_stock`, p.stockLabel);
  }

  return {
    ok: true,
    category: CATEGORY_ID,
    scraped: results.length,
    notif: notifications.length,
    notifications
  };
}

function parseProducts(html) {
  const items = [];
  const re = new RegExp(`<div class="goods-item"[\\s\\S]*?<\\/div>\\s*<\\/div>`, "gi");
  let m;
  while ((m = re.exec(html)) !== null) {
    const block = m[0];

    const name = pick(block, /<h3[^>]*>([^<]+)<\/h3>/i);
    const saleRaw = pick(block, /<span class="price-num"[^>]*>([\d\.]+)</i);
    const origRaw = pick(block, /<span class="old"[^>]*>Rp\s?([\d\.]+)</i);
    const discRaw = pick(block, /<span class="off"[^>]*>-(\d+)%</i);

    if (!name) continue;

    items.push({
      name: name.trim(),
      salePrice: num(saleRaw),
      originalPrice: num(origRaw),
      discount: discRaw ? Number(discRaw) : 0
    });
  }
  return items;
}

/* Helpers */
function pick(s, re) { const m = s.match(re); return m ? m[1] : null; }
function num(s) { return s ? Number(s.replace(/\./g, "")) : null; }
function normNum(n) { return Number.isFinite(Number(n)) ? Number(n) : null; }
function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-"); }
function fmt(n) { return "Rp" + Number(n).toLocaleString("id-ID"); }
function formatMsg(isNew, priceDrop, restock, p) {
  const title = isNew ? "🆕 Baru!" : priceDrop ? "🔥 Harga Turun!" : "✅ Restock!";
  return `${title}\n${p.name}\n💰 ${fmt(p.salePrice)}\n📦 ${p.stockLabel}\n🔗 ${p.url}`;
}

async function fetchHtml(url) { return await (await fetch(url)).text(); }
async function fetchJson(url) { try { return await (await fetch(url)).json(); } catch { return null; } }

async function sendTG(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg })
    });
  } catch {}
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
