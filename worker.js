/**
 * Vivo Refurbished Category 53 — PRO v14 (corner-pic logic)
 * ✅ READY = TIDAK ada elemen dengan class "corner-pic" (apapun variannya)
 * ✅ Test mode ?test=ready => hanya produk READY; jika none, items=[]
 * ✅ Harga prioritas dari HTML; API hanya fallback jika html kosong (tidak memaksa 0)
 * ✅ KV tracking + Telegram
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
    return json({ ok: true, message: "Vivo Checker PRO v14 ✅ (corner-pic)" });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runJob(env, new Request("https://cron-trigger")));
  }
};

async function runJob(env, request) {
  if (!env?.STORE) return { ok:false, error:"❌ KV Binding STORE belum terhubung!" };

  const url = new URL(request.url);
  const testMode = url.searchParams.get("test");

  // 1) Ambil HTML dan parse dasar (nama, harga HTML, status stok via corner-pic)
  const html  = await fetchHtml(LIST_URL);
  const basic = listBasic(html);            // harga dari HTML + stok via corner-pic

  // 2) Lengkapi harga via API jika di HTML kosong (tanpa mengubah stok)
  const list  = await enrichPrice(basic);

  if (testMode === "ready") {
    const readyOnly = list.filter(x => x.stockLabel === "Tersedia");
    return {
      ok: true,
      test: "ready_only",
      ready_count: readyOnly.length,
      items: readyOnly
    };
  }

  if (!list.length) return { ok:false, error:"Tidak ada produk ditemukan 🚫" };

  const changes = [];
  for (const p of list) {
    const idKey    = slug(p.name);
    const oldPrice = await env.STORE.get(`${idKey}_price`, "json");
    const oldStock = await env.STORE.get(`${idKey}_stock`, "text");

    const isNew     = (oldPrice === null && oldStock === null);
    const priceDrop = (typeof oldPrice === "number" && p.salePrice != null && p.salePrice < oldPrice);
    const restock   = (oldStock && oldStock !== "Tersedia" && p.stockLabel === "Tersedia");

    if (isNew || priceDrop || restock) {
      const event = isNew ? "NEW" : priceDrop ? "PRICE_DROP" : "RESTOCK";
      changes.push({ event, product: p });
      await sendTG(formatMsg(isNew, priceDrop, restock, p));
    }

    // simpan state terbaru (KV boleh 0 untuk sentinel, tapi output API tidak dipaksa 0)
    await env.STORE.put(`${idKey}_price`, JSON.stringify(p.salePrice ?? 0));
    await env.STORE.put(`${idKey}_stock`, p.stockLabel);
  }

  return { ok:true, scraped:list.length, notif:changes.length, notifications:changes };
}

/* ======================= PARSER HTML (utama) ======================= */
/* Ambil goods-item, nama, harga HTML, dan status stok via corner-pic */
function listBasic(html) {
  const out = [];
  // Tangkap blok sedikit lebih panjang, lalu kita punya fallback scan-nearby juga
  const blockRe = /<div class="goods-item"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const block = m[0];

    const name = pick(block, /<h3[^>]*>([^<]+)<\/h3>/i);
    if (!name) continue;

    const saleRaw = pick(block, /<span class="price-num"[^>]*>([\d\.]+)/i);
    const origRaw = pick(block, /<span class="old"[^>]*>Rp\s?([\d\.]+)/i);
    const discRaw = pick(block, /<span class="off"[^>]*>-(\d+)%/i);

    const salePrice     = saleRaw ? toNum(saleRaw) : null;
    const originalPrice = origRaw ? toNum(origRaw) : null;
    const discount      = discRaw
      ? Number(discRaw)
      : (salePrice && originalPrice && originalPrice > salePrice
          ? Math.round(((originalPrice - salePrice) / originalPrice) * 100)
          : 0);

    // === STOCK VIA CORNER-PIC ===
    const stockLabel = detectStockByCorner(block, html, m.index);

    out.push({
      name: name.trim(),
      salePrice,
      originalPrice,
      discount,
      stockLabel,       // "Tersedia" | "Habis"
      spuId: null,
      url: LIST_URL
    });
  }
  return out;
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
        if (orig && sale && orig > sale) disc = Math.round(((orig - sale) / orig) * 100);

        if (best.spuId) {
          spu = best.spuId;
          url = `https://shop.vivo.com/id/product/${spu}`;
        }
      }
    }

    out.push({
      name: b.name,
      salePrice: sale ?? null,
      originalPrice: orig ?? null,
      discount: disc ?? 0,
      stockLabel: b.stockLabel,  // tetap dari corner-pic
      spuId: spu,
      url
    });
  }
  return out;
}

/* ======================= STOCK DETECTOR (corner-pic) ======================= */
/**
 * Aturan:
 * - Jika ADA elemen dengan class yg mengandung "corner-pic" → HABIS
 * - Jika TIDAK ADA "corner-pic" sama sekali → Tersedia
 * Termasuk variasi: <img ... class="corner-pic ..."> atau <div ... class="corner-pic ...">
 * Fallback: scan area sekitar blok untuk menangkap corner-pic di sibling/parent container.
 */
function detectStockByCorner(block, fullHtml, blockStartIdx) {
  // langsung di blok
  if (hasCornerPic(block)) return "Habis";

  // fallback: kadang badge-nya di luar potongan kecil; scan ke depan beberapa kb
  const NEAR_SPAN = 3500; // cukup besar untuk cover container card
  const near = fullHtml.slice(blockStartIdx, Math.min(blockStartIdx + NEAR_SPAN, fullHtml.length));
  if (hasCornerPic(near)) return "Habis";

  // tidak ketemu corner-pic → READY
  return "Tersedia";
}

// true jika ada tag dengan class mengandung "corner-pic"
function hasCornerPic(s) {
  // cari tag yang memiliki class dan mengandung substring 'corner-pic'
  return /<[^>]+class\s*=\s*["'][^"']*\bcorner-pic\b[^"']*["'][^>]*>/i.test(s);
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
