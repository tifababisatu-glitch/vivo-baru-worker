/**
 * Vivo Refurbished Category 53 — PRO v17 (boundary-safe + pagination)
 * ✅ READY  = segmen kartu TANPA <img class="corner-pic"...>
 * ❌ HABIS  = segmen kartu ADA <img class="corner-pic"...>
 * ✅ Test modes: ?test=ready | ?test=all | ?test=corner
 * ✅ Harga: HTML prioritas, API hanya fallback (output tidak dipaksa 0)
 * ✅ KV tracking + Telegram (NEW / PRICE_DROP / RESTOCK)
 * ✅ Pagination: coba pola ?page=1..N (stop saat kosong/duplikat)
 */

const CATEGORY_ID = 53;
const BASE_LIST   = `https://shop.vivo.com/id/products/phone?categoryId=${CATEGORY_ID}`;

// Coba beberapa pola page param (untuk halaman yang pakai SSR/CSR berbeda)
const PAGE_PATTERNS = [
  (p) => `${BASE_LIST}&page=${p}`,
  (p) => `${BASE_LIST}&page=${p}&pageSize=24`,
  (p) => `${BASE_LIST}&pageNum=${p}`,
];

const MAX_PAGES   = 12; // batas aman
const PAGE_QUIT_EMPTY_STREAK = 2; // jika 2 kali berturut-turut kosong → stop

// === TELEGRAM CONFIG ===
const TG_TOKEN = "8322901606:AAHrCt-ODhFqlC0ZIQSf0WL8WlUvwSJeYeU";
const TG_CHAT  = "253407101";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      return json(await runJob(env, request));
    }
    return json({ ok: true, message: "Vivo Checker PRO v17 ✅ (corner-pic + pagination)" });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runJob(env, new Request("https://cron-trigger")));
  }
};

async function runJob(env, request) {
  if (!env?.STORE) return { ok:false, error:"❌ KV STORE belum terhubung!" };

  const url = new URL(request.url);
  const testMode = url.searchParams.get("test");

  // 1) Ambil semua halaman (pagination best-effort)
  const pages = await fetchAllPages();
  if (pages.length === 0) return { ok:false, error:"Tidak bisa mengambil halaman produk 🚫" };

  // 2) Parse per halaman → gabungkan
  let allItems = [];
  for (const { html } of pages) {
    const items = listBasic(html); // boundary-safe + stok by corner-pic
    allItems = allItems.concat(items);
  }

  // Hilangkan duplikat by nama (kadang muncul di beberapa page pola berbeda)
  allItems = dedupeBy(allItems, x => x.name.toLowerCase());

  // 3) Lengkapi harga via API (tanpa mengubah stok)
  const list = await enrichPrice(allItems);

  // ==== TEST MODES ====
  if (testMode === "ready") {
    const readyOnly = list.filter(x => x.stockLabel === "Tersedia");
    return { ok:true, test:"ready_only", ready_count:readyOnly.length, items:readyOnly };
  }
  if (testMode === "all") {
    return { ok:true, test:"all", count:list.length, items:list };
  }
  if (testMode === "corner") {
    // debug: tampilkan bukti corner-pic per item (true/false + snippet)
    const debug = [];
    for (const { html } of pages) {
      const segments = sliceGoodsItemSegments(html);
      for (const seg of segments) {
        const name = pick(seg, /<h3[^>]*>([^<]+)<\/h3>/i);
        if (!name) continue;
        const found = hasCornerPic(seg);
        debug.push({
          name: name.trim(),
          cornerFound: !!found,
          snippet: trimSnippet(found ? extractCornerTag(seg) : seg, 320)
        });
      }
    }
    // gabungkan by name (first wins)
    const merged = dedupeBy(debug, d => d.name.toLowerCase());
    return { ok:true, test:"corner", items: merged };
  }

  if (!list.length) return { ok:false, error:"Tidak ada produk ditemukan 🚫" };

  // 4) Diff + Notifikasi
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
    // Simpan state (boleh 0 sentinel untuk KV; output API tidak dipaksa 0)
    await env.STORE.put(`${idKey}_price`, JSON.stringify(p.salePrice ?? 0));
    await env.STORE.put(`${idKey}_stock`, p.stockLabel);
  }

  return { ok:true, scraped:list.length, notif:changes.length, notifications:changes };
}

/* ======================= FETCH ALL PAGES ======================= */
async function fetchAllPages() {
  const out = [];
  const seenHashes = new Set();

  // Halaman 1: selalu ambil BASE (tanpa param) dulu
  const firstHtml = await fetchHtml(BASE_LIST);
  if (firstHtml) {
    const h = hashText(firstHtml);
    if (!seenHashes.has(h)) {
      out.push({ page: 1, pattern: "base", html: firstHtml });
      seenHashes.add(h);
    }
  }

  let emptyStreak = 0;

  for (let p = 1; p <= MAX_PAGES; p++) {
    let pageHit = false;

    for (const pat of PAGE_PATTERNS) {
      const url = pat(p);
      const html = await fetchHtml(url);
      if (!html) continue;

      // Jika halaman mengandung goods-item baru, simpan
      const segments = sliceGoodsItemSegments(html);
      if (segments.length === 0) continue;

      const h = hashText(html);
      if (seenHashes.has(h)) continue; // duplikat konten

      out.push({ page: p, pattern: url, html });
      seenHashes.add(h);
      pageHit = true;
      // Lanjut ke p berikutnya; tetap coba pola lain p yang sama pada iterasi berikut (agar tidak spam)
      break;
    }

    if (!pageHit) {
      emptyStreak++;
      if (emptyStreak >= PAGE_QUIT_EMPTY_STREAK) break;
    } else {
      emptyStreak = 0;
    }
  }

  return out;
}

/* ======================= PARSER (Boundary-Safe) ======================= */
function listBasic(html) {
  const out = [];
  const segments = sliceGoodsItemSegments(html);

  for (const seg of segments) {
    const name = pick(seg, /<h3[^>]*>([^<]+)<\/h3>/i);
    if (!name) continue;

    const saleRaw = pick(seg, /<span class="price-num"[^>]*>([\d\.]+)/i);
    const origRaw = pick(seg, /<span class="old"[^>]*>Rp\s?([\d\.]+)/i);
    const discRaw = pick(seg, /<span class="off"[^>]*>-(\d+)%/i);

    const salePrice     = saleRaw ? toNum(saleRaw) : null;
    const originalPrice = origRaw ? toNum(origRaw) : null;
    const discount      = discRaw
      ? Number(discRaw)
      : (salePrice && originalPrice && originalPrice > salePrice
          ? Math.round(((originalPrice - salePrice) / originalPrice) * 100)
          : 0);

    // ✅ STOCK: hanya cek DI DALAM segmen kartu
    const stockLabel = hasCornerPic(seg) ? "Habis" : "Tersedia";

    out.push({
      name: name.trim(),
      salePrice,
      originalPrice,
      discount,
      stockLabel,
      spuId: null,
      url: BASE_LIST
    });
  }

  return out;
}

function sliceGoodsItemSegments(html) {
  const starts = [];
  const openRe = /<div\s+class=["'][^"']*\bgoods-item\b[^"']*["'][^>]*>/gi;
  let m;
  while ((m = openRe.exec(html)) !== null) {
    starts.push(m.index);
  }
  if (starts.length === 0) return [];

  const segs = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end   = (i + 1 < starts.length) ? starts[i + 1] : html.length;
    segs.push(html.slice(start, end));
  }
  return segs;
}

/* ========== PRICE ENRICHER (opsional, non-stock) ========== */
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

        if (orig && sale && orig > sale) {
          disc = Math.round(((orig - sale) / orig) * 100);
        }

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
      stockLabel: b.stockLabel, // stok tidak diubah
      spuId: spu,
      url
    });
  }
  return out;
}

/* ======================= DETECTOR ======================= */
// Hanya anggap HABIS jika di dalam segmen ada <img ... class="corner-pic"...>
function hasCornerPic(s) {
  return /<img[^>]*class=["'][^"']*\bcorner-pic\b[^"']*["'][^>]*>/i.test(s);
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
const dedupeBy = (arr, keyFn) => {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const k = keyFn(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
};
const trimSnippet = (html, max = 240) => (html.length > max ? html.slice(0, max) + "…" : html);

// cari tag corner sebagai bukti (untuk mode debug)
function extractCornerTag(seg) {
  const m = seg.match(/<img[^>]*class=["'][^"']*\bcorner-pic\b[^"']*["'][^>]*>/i);
  return m ? m[0] : seg.slice(0, 200);
}

function formatMsg(isNew, priceDrop, restock, p) {
  const title = isNew ? "🆕 Baru!" : priceDrop ? "🔥 Turun Harga!" : "✅ Restock!";
  const priceLine = p.salePrice != null ? `💰 ${fmt(p.salePrice)}` : "💰 ?";
  return `${title}
${p.name}
${priceLine}
📦 ${p.stockLabel}
🔗 ${p.url}`;
}

async function fetchHtml(url) {
  try {
    const r = await fetch(url, { headers:{ "User-Agent":"Mozilla/5.0" }});
    if (!r.ok) return "";
    return await r.text();
  } catch {
    return "";
  }
}
async function fetchJson(url) {
  try {
    const r = await fetch(url, { headers:{ "User-Agent":"Mozilla/5.0" }});
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}
async function sendTG(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text })
    });
  } catch {}
}
function json(obj, status=200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status, headers:{ "Content-Type":"application/json" }
  });
}
function hashText(s) {
  // FNV-1a sederhana
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h.toString(16);
}
