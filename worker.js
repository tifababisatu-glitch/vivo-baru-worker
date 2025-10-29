/**
 * Vivo Refurbished Category 53 — PRO v18 (SKU-aware)
 * ✅ READY/HABIS by <img class="corner-pic"...> in segment only
 * ✅ Multi-SKU per SPU dihitung sebagai item terpisah
 * ✅ variant = "<description>"
 * ✅ Test modes: ?test=ready | ?test=all | ?test=corner
 */

const CATEGORY_ID = 53;
const BASE_LIST   = `https://shop.vivo.com/id/products/phone?categoryId=${CATEGORY_ID}`;
const PAGE_PATTERNS = [
  (p) => `${BASE_LIST}&page=${p}`,
  (p) => `${BASE_LIST}&pageNum=${p}`,
];
const MAX_PAGES = 10;
const PAGE_QUIT_EMPTY_STREAK = 2;

// Telegram
const TG_TOKEN = "8322901606:AAHrCt-ODhFqlC0ZIQSf0WL8WlUvwSJeYeU";
const TG_CHAT  = "253407101";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      return json(await runJob(env, request));
    }
    return json({ ok: true, message: "Vivo Checker PRO v18 ✅ (SKU-aware)" });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runJob(env, new Request("https://cron-trigger")));
  }
};

async function runJob(env, request) {
  if (!env?.STORE) return { ok:false, error:"KV STORE missing" };

  const url = new URL(request.url);
  const testMode = url.searchParams.get("test");

  const pages = await fetchAllPages();
  if (!pages.length) return { ok:false, error:"no pages" };

  let items = [];
  for (const { html } of pages) {
    items = items.concat(listBasic(html));
  }

  // ✅ Dedupe by name + variant
  items = dedupeBy(items, x => (x.name + "|" + x.variant).toLowerCase());

  const list = await enrichPrice(items);

  if (testMode === "ready") {
    const readyOnly = list.filter(x => x.stockLabel === "Tersedia");
    return { ok:true, test:"ready_only", ready_count:readyOnly.length, items:readyOnly };
  }
  if (testMode === "all") {
    return { ok:true, count:list.length, items:list };
  }
  if (testMode === "corner") {
    const debug = [];
    for (const { html } of pages) {
      for (const seg of sliceSegments(html)) {
        const name = pick(seg, /<h3[^>]*>([^<]+)<\/h3>/i);
        if (!name) continue;
        const variant = (pick(seg, /<div class="description"[^>]*>([^<]+)<\/div>/i) ?? "").trim();
        const found = hasCornerPic(seg);
        debug.push({
          name: name.trim(),
          variant,
          cornerFound: found,
          snippet: found ? extractCorner(seg) : ""
        });
      }
    }
    return { ok:true, test:"corner", items: dedupeBy(debug, x=> (x.name + x.variant).toLowerCase()) };
  }

  // === Normal update mode ===
  const changes = [];
  for (const p of list) {
    const key = slug(p.name + "|" + p.variant);
    const oldPrice = await env.STORE.get(`${key}_price`, "json");
    const oldStock = await env.STORE.get(`${key}_stock`, "text");

    const isNew = (oldPrice === null && oldStock === null);
    const priceDrop = (typeof oldPrice === "number" && p.salePrice != null && p.salePrice < oldPrice);
    const restock = (oldStock && oldStock !== "Tersedia" && p.stockLabel === "Tersedia");

    if (isNew || priceDrop || restock) {
      await sendTG(formatMsg(isNew, priceDrop, restock, p));
      changes.push({ event: isNew ? "NEW" : priceDrop ? "PRICE_DROP" : "RESTOCK", product:p });
    }

    await env.STORE.put(`${key}_price`, JSON.stringify(p.salePrice ?? 0));
    await env.STORE.put(`${key}_stock`, p.stockLabel);
  }

  return { ok:true, scraped:list.length, notif:changes.length, notifications:changes };
}

/* ===== Pagination Fetch ===== */
async function fetchAllPages() {
  const out = [];
  const seenHashes = new Set();

  let empty = 0;
  for (let p = 1; p <= MAX_PAGES; p++) {
    let got = false;
    for (const pat of PAGE_PATTERNS) {
      const url = pat(p);
      const html = await fetchHtml(url);
      if (!html) continue;

      const segs = sliceSegments(html);
      if (!segs.length) continue;

      const h = hash(html);
      if (seenHashes.has(h)) continue;
      seenHashes.add(h);

      out.push({page:p, html});
      got = true;
      break;
    }

    if (!got) {
      empty++;
      if (empty >= PAGE_QUIT_EMPTY_STREAK) break;
    } else empty = 0;
  }
  return out;
}

/* ===== Boundary-safe Segmentation ===== */
function sliceSegments(html) {
  const starts = [];
  const re = /<div\s+class=["'][^"']*\bgoods-item\b[^"']*["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    starts.push(m.index);
  }
  starts.push(html.length);

  return starts.slice(0,-1).map((st,i)=> html.slice(st, starts[i+1]));
}

/* ===== Parse Basic Fields ===== */
function listBasic(html) {
  const out = [];
  for (const seg of sliceSegments(html)) {
    const name = pick(seg, /<h3[^>]*>([^<]+)<\/h3>/i);
    if (!name) continue;
    const variant = (pick(seg, /<div class="description"[^>]*>([^<]+)<\/div>/i) ?? "").trim();

    const saleRaw = pick(seg, /<span class="price-num"[^>]*>([\d\.]+)/i);
    const origRaw = pick(seg, /<span class="old"[^>]*>Rp\s?([\d\.]+)/i);

    const sale = saleRaw ? toNum(saleRaw) : null;
    const orig = origRaw ? toNum(origRaw) : null;
    const disc = (sale && orig && orig > sale)
      ? Math.round(((orig - sale) / orig) * 100)
      : 0;

    const stockLabel = hasCornerPic(seg) ? "Habis" : "Tersedia";

    out.push({
      name: name.trim(),
      variant,     // ✅ SKU info
      salePrice: sale,
      originalPrice: orig,
      discount: disc,
      stockLabel,
      url: BASE_LIST
    });
  }
  return out;
}

/* ===== Price Enricher ===== */
async function enrichPrice(list) {
  const out = [];
  for (const b of list) {
    let sale = b.salePrice;
    let orig = b.originalPrice;
    let disc = b.discount;
    let spu  = null;
    let url  = b.url;

    if (sale == null || orig == null) {
      const det = await fetchJson(`https://shop.vivo.com/api/v3/product/search?keyword=${encodeURIComponent(b.name)}`);
      const best = det?.data?.list?.find(x=>true);
      if (best) {
        if (sale == null) sale = toNum(best.salePrice);
        if (orig == null) orig = toNum(best.originalPrice);
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
      ...b,
      salePrice: sale ?? null,
      originalPrice: orig ?? null,
      discount: disc ?? 0,
      spuId: spu,
      url
    });
  }
  return out;
}

/* ===== Detect Stock ===== */
const hasCornerPic = (seg) =>
  /<img[^>]*class=["'][^"']*\bcorner-pic\b/i.test(seg);

/* ===== Helpers ===== */
const pick = (s,re)=> (s.match(re) || [])[1] || null;
const toNum = (v)=> Number(String(v).replace(/\./g,"").replace(/[^\d]/g,""));
const slug = (s)=> s.toLowerCase().replace(/[^a-z0-9]+/g,"-");
const dedupeBy = (arr,key)=> {
  const seen = new Set();
  return arr.filter(x=>{
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};
const extractCorner = seg => (seg.match(/<img[^>]*class=["'][^"']*\bcorner-pic\b[^"']*["'][^>]*>/i) || [])[0] ?? "";
const hash = s => crypto.subtle.digest("SHA-1", new TextEncoder().encode(s)).then(buf=>{
  return Array.from(new Uint8Array(buf)).map(x=>x.toString(16).padStart(2,"0")).join("");
});
const fmt = n => `Rp${Number(n).toLocaleString("id-ID")}`;

async function fetchHtml(url) {
  try {
    const r = await fetch(url, { headers:{ "User-Agent":"Mozilla/5.0" }});
    if (!r.ok) return "";
    return await r.text();
  } catch { return ""; }
}
async function fetchJson(url) {
  try {
    const r = await fetch(url, { headers:{ "User-Agent":"Mozilla/5.0" }});
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
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
function json(obj,status=200) {
  return new Response(JSON.stringify(obj,null,2), {
    status, headers:{ "Content-Type":"application/json" }
  });
}
