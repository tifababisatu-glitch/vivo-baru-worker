/**
 * Vivo Refurbished Category 53 — PRO v13
 * ✅ READY = tombol "Beli Sekarang" benar-benar klik-able (bukan disabled/aria-disabled/is-disabled/href="#" dll)
 * ✅ Test mode ?test=ready => hanya produk READY; jika tidak ada, items=[]
 * ✅ Harga diutamakan dari HTML; API hanya fallback. Di output tidak pernah dipaksa 0.
 * ✅ KV tracking + Telegram + Cron
 */

const CATEGORY_ID = 53;
const LIST_URL = `https://shop.vivo.com/id/products/phone?categoryId=${CATEGORY_ID}`;
const SEARCH_API = (k) =>
  `https://shop.vivo.com/api/v3/product/search?keyword=${encodeURIComponent(k)}&page=1&pageSize=6&platform=1&channel=UTF-8&country=ID`;

// === TELEGRAM CONFIG ===
const TG_TOKEN = "8322901606:AAHrCt-ODhFqlC0ZIQSf0WL8WlUvwSJeYeU";
const TG_CHAT  = "253407101";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      return json(await runJob(env, request));
    }
    return json({ ok: true, message: "Vivo Checker PRO v13 ✅" });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runJob(env, new Request("https://cron-trigger")));
  }
};

async function runJob(env, request) {
  if (!env?.STORE) return { ok:false, error:"❌ KV Binding STORE belum terhubung!" };

  const url = new URL(request.url);
  const testMode = url.searchParams.get("test");

  // 1) Ambil HTML dan parse dasar (nama, harga HTML, status tombol)
  const html = await fetchHtml(LIST_URL);
  const basic = listBasic(html);            // harga dari HTML (prioritas)
  // 2) Lengkapi harga via API jika di HTML kosong (tanpa mengubah stok)
  const list  = await enrichPrice(basic);   // stokLabel tetap dari tombol, tidak dari API

  if (testMode === "ready") {
    const readyOnly = list.filter(x => x.stockLabel === "Tersedia");
    return {
      ok: true,
      test: "ready_only",
      ready_count: readyOnly.length,
      items: readyOnly   // ⛔️ tidak ada fallback, hanya yang benar2 ready
    };
  }

  if (!list.length) return { ok:false, error:"Tidak ada produk ditemukan 🚫" };

  const changes = [];
  for (const p of list) {
    const idKey    = slug(p.name);
    const oldPrice = await env.STORE.get(`${idKey}_price`, "json");
    const oldStock = await env.STORE.get(`${idKey}_stock`, "text");

    const isNew    = (oldPrice === null && oldStock === null);
    const priceDrop= (typeof oldPrice === "number" && p.salePrice != null && p.salePrice < oldPrice);
    const restock  = (oldStock && oldStock !== "Tersedia" && p.stockLabel === "Tersedia");

    if (isNew || priceDrop || restock) {
      changes.push({ event: isNew ? "NEW" : priceDrop ? "PRICE_DROP" : "RESTOCK", product: p });
      await sendTG(formatMsg(isNew, priceDrop, restock, p));
    }

    // simpan state terbaru (KV boleh 0 untuk sentinel, tapi output API tidak dipaksa 0)
    await env.STORE.put(`${idKey}_price`, JSON.stringify(p.salePrice ?? 0));
    await env.STORE.put(`${idKey}_stock`, p.stockLabel);
  }

  return { ok:true, scraped:list.length, notif:changes.length, notifications:changes };
}

/* ======================= PARSER HTML (utama) ======================= */
/* Ambil blok goods-item, nama, harga dari HTML, dan status tombol "Beli Sekarang" */
function listBasic(html) {
  const out = [];
  const blockRe = /<div class="goods-item"[\s\S]*?<\/div>\s*<\/div>/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const block = m[0];

    const name    = pick(block, /<h3[^>]*>([^<]+)<\/h3>/i);
    if (!name) continue;

    const saleRaw = pick(block, /<span class="price-num"[^>]*>([\d\.]+)/i);
    const origRaw = pick(block, /<span class="old"[^>]*>Rp\s?([\d\.]+)/i);
    const discRaw = pick(block, /<span class="off"[^>]*>-(\d+)%/i);

    const salePrice     = saleRaw ? toNum(saleRaw) : null;     // ❗ biarkan null jika tak ada
    const originalPrice = origRaw ? toNum(origRaw) : null;
    const discount      = discRaw ? Number(discRaw) : (salePrice && originalPrice && originalPrice>salePrice
                              ? Math.round(((originalPrice-salePrice)/originalPrice)*100) : 0);

    const stockLabel    = detectBuyButton(block) ? "Tersedia" : "Habis";

    out.push({
      name: name.trim(),
      salePrice,
      originalPrice,
      discount,
      stockLabel,
      spuId: null,
      url: LIST_URL
    });
  }
  return out;
}

/* Tombol "Beli Sekarang" dianggap klik-able jika:
   - ada elemen <a> / <button> yg mengandung teks "Beli Sekarang" (case-insensitive)
   - dan tidak mengandung atribut disabled/aria-disabled/is-disabled/btn-disabled
   - dan href bukan "#" / "javascript:void(0)"
*/
function detectBuyButton(block) {
  const btnRegex = /<(a|button)\b[^>]*>[\s\S]*?beli\s*sekarang[\s\S]*?<\/\1>/gi;
  const cand = btnRegex.exec(block);
  if (!cand) return false;

  const openTag = (cand[0].match(/^<(a|button)\b[^>]*>/i) || [""])[0];

  const hasDisabled =
    /\bdisabled\b/i.test(openTag) ||
    /aria-disabled\s*=\s*["']?\s*true\s*["']?/i.test(openTag) ||
    /class\s*=\s*["'][^"']*(?:\bis-disabled\b|\bbtn-disabled\b|\bdisabled\b)[^"']*["']/i.test(openTag);

  const badHref = /href\s*=\s*["']\s*(?:#|javascript:void\(0\))\s*["']/i.test(openTag);

  return !(hasDisabled || badHref);
}

/* ======================= ENRICH HARGA (opsional) ======================= */
/* Hanya melengkapi harga dari API jika HTML kosong; stokLabel TIDAK diubah */
async function enrichPrice(list) {
  const out = [];
  for (const b of list) {
    let sale = b.salePrice;
    let orig = b.originalPrice;
    let disc = b.discount;
    let spu  = null;
    let url  = b.url;

    if (sale == null || orig == null) {
      const det  = await fetchJson(SEARCH_API(b.name));
      const best = det?.data?.list?.[0] || null;

      if (best) {
        const apiSale = toNum(best.salePrice);
        const apiOrig = toNum(best.originalPrice);
        if (sale == null && apiSale != null) sale = apiSale;
        if (orig == null && apiOrig != null) orig = apiOrig;

        if (orig && sale && orig>sale) disc = Math.round(((orig-sale)/orig)*100);

        if (best.spuId) {
          spu = best.spuId;
          url = `https://shop.vivo.com/id/product/${spu}`;
        }
      }
    }

    out.push({
      name: b.name,
      salePrice: sale ?? null,           // ❗ tetap null jika tidak ketemu
      originalPrice: orig ?? null,
      discount: disc ?? 0,
      stockLabel: b.stockLabel,          // ❗ tetap dari tombol
      spuId: spu,
      url
    });
  }
  return out;
}

/* ======================= HELPERS ======================= */
function pick(s, re) { const m = s.match(re); return m ? m[1] : null; }
function toNum(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/\./g, "").replace(/[^\d]/g, ""));
  return Number.isFinite(n) ? n : null;
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const fmt  = (n) => `Rp${Number(n).toLocaleString("id-ID")}`;

function formatMsg(isNew, priceDrop, restock, p) {
  const title = isNew ? "🆕 Baru!" : priceDrop ? "🔥 Harga Turun!" : "✅ Restock!";
  const priceLine = p.salePrice != null ? `💰 ${fmt(p.salePrice)}` : `💰 -`;
  return `${title}
${p.name}
${priceLine}
📦 ${p.stockLabel}
🔗 ${p.url}`;
}

async function fetchHtml(url) { return await (await fetch(url, { headers:{ "User-Agent":"Mozilla/5.0" }})).text(); }
async function fetchJson(url) { try { const r = await fetch(url, { headers:{ "User-Agent":"Mozilla/5.0" }}); if (!r.ok) return null; return await r.json(); } catch { return null; } }
async function sendTG(text) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text })
  });
}
function json(obj, status=200) { return new Response(JSON.stringify(obj, null, 2), { status, headers:{ "Content-Type":"application/json" } }); }
