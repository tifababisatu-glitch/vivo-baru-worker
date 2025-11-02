/**
 * Vivo Refurbished Checker — PRO v19 (SKU-aware + stable, secure)
 * ✅ READY  = TANPA <img class="corner-pic"...> dalam segmen
 * ✅ HABIS  = ADA <img class="corner-pic"...> dalam segmen
 * ✅ Multi-SKU, varian unik → no duplicate loss
 * ✅ Telegram test: ?test=pingtg
 */

const CATEGORY_ID = 53;
const BASE_LIST   = `https://shop.vivo.com/id/products/phone?categoryId=${CATEGORY_ID}`;
const PAGE_PATTERNS = [
  (p) => `${BASE_LIST}&page=${p}`,
  (p) => `${BASE_LIST}&pageNum=${p}`,
];
const MAX_PAGES = 10;
const PAGE_QUIT_EMPTY_STREAK = 2;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      return json(await runJob(env, request));
    }
    return json({ ok:true, message:"Vivo Checker PRO v19 ✅" });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runJob(env, new Request("https://cron-trigger")));
  }
};

async function runJob(env, request) {
  if (!env?.STORE) return { ok:false, error:"KV STORE missing!" };

  const url = new URL(request.url);
  const testMode = url.searchParams.get("test");

  const pages = await fetchAllPages();
  if (!pages.length) return { ok:false, error:"cant fetch pages" };

  let items = [];
  for (const { html } of pages) {
    items = items.concat(listBasic(html));
  }

  // ✅ SKU unique
  items = dedupe(items);

  const list = await enrichPrice(items);

  /* === TEST MODES === */
  if (testMode === "ready") {
    const r = list.filter(x=>x.stockLabel==="Tersedia");
    return { ok:true, test:"ready_only", ready_count:r.length, items:r };
  }
  if (testMode === "all") {
    return { ok:true, count:list.length, items:list };
  }
  if (testMode === "corner") {
    return { ok:true, test:"corner_debug", items:cornerDebug(pages) };
  }
  if (testMode === "pingtg") {
    await sendTG(env, "🔔 Telegram Test OK!");
    return { ok:true, test:"pingtg", sent:true };
  }

  /* === NORMAL UPDATE === */
  const changes = [];
  for (const p of list) {
    const key = slug(p.name+"_v_"+p.variant);

    const oldPrice = await env.STORE.get(`${key}_price`, "json");
    const oldStock = await env.STORE.get(`${key}_stock`, "text");

    const isNew     = (oldPrice===null && oldStock===null);
    const priceDrop = (typeof oldPrice==="number" && p.salePrice!=null && p.salePrice < oldPrice);
    const restock   = (oldStock && oldStock!=="Tersedia" && p.stockLabel==="Tersedia");

    if (isNew || priceDrop || restock) {
      await sendTG(env, formatMsg(isNew, priceDrop, restock, p));
      changes.push({ event: isNew?"NEW":priceDrop?"PRICE_DROP":"RESTOCK", product:p });
    }

    await env.STORE.put(`${key}_price`, JSON.stringify(p.salePrice ?? 0));
    await env.STORE.put(`${key}_stock`, p.stockLabel);
  }

  return { ok:true, scraped:list.length, notif:changes.length, notifications:changes };
}

/* ========= Pagination ========= */
async function fetchAllPages() {
  const out = [];
  const seen = new Set();
  let empty = 0;

  for (let p=1; p<=MAX_PAGES; p++) {
    let got = false;
    for (const pat of PAGE_PATTERNS) {
      const url = pat(p);
      const html = await fetchHtml(url);
      if (!html) continue;

      const segs = sliceSegments(html);
      if (!segs.length) continue;

      const h = hash(html);
      if (seen.has(h)) continue;
      seen.add(h);
      out.push({page:p, html});
      got=true;
      break;
    }
    if (!got) {
      empty++;
      if (empty>=PAGE_QUIT_EMPTY_STREAK) break;
    } else empty=0;
  }
  return out;
}

/* ========= Parse boundary-safe ========= */
function sliceSegments(html) {
  const starts = [];
  const re = /<div\s+class=["'][^"']*\bgoods-item\b[^"']*["'][^>]*>/gi;
  let m;
  while ((m=re.exec(html))!==null) starts.push(m.index);
  if (!starts.length) return [];
  starts.push(html.length);
  return starts.slice(0,-1).map((st,i)=> html.slice(st, starts[i+1]));
}

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
    const disc = (sale && orig && orig>sale)
        ? Math.round(((orig-sale)/orig)*100)
        : 0;

    const stockLabel = hasCornerPic(seg) ? "Habis" : "Tersedia";

    out.push({
      name:name.trim(),
      variant,
      salePrice:sale,
      originalPrice:orig,
      discount:disc,
      stockLabel,
      url:BASE_LIST
    });
  }
  return out;
}

/* ========= Price fallback ========= */
async function enrichPrice(list) {
  const out=[];
  for (const x of list) {
    let {salePrice, originalPrice, discount} = x;

    if (salePrice==null || originalPrice==null) {
      const det = await fetchJson(`https://shop.vivo.com/api/v3/product/search?keyword=${encodeURIComponent(x.name)}`);
      const best = det?.data?.list?.[0];
      if (best) {
        const s = toNum(best.salePrice);
        const o = toNum(best.originalPrice);
        if (salePrice==null && s!=null) salePrice=s;
        if (originalPrice==null && o!=null) originalPrice=o;
        if (o && s && o>s) discount=Math.round(((o-s)/o)*100);
      }
    }

    out.push({...x, salePrice, originalPrice, discount});
  }
  return out;
}

/* ========= Stock logic ========= */
const hasCornerPic = seg =>
  /<img[^>]*class=["'][^"']*\bcorner-pic\b/i.test(seg);

/* ========= Dedupe SKU ========= */
function dedupe(arr) {
  const seen=new Set();
  return arr.filter(x=>{
    const key=(x.name+"|"+x.variant).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ========= Debug ========= */
function cornerDebug(pages) {
  const dbg=[];
  for (const {html} of pages) {
    for (const seg of sliceSegments(html)) {
      const name = pick(seg,/<h3[^>]*>([^<]+)<\/h3>/i);
      if (!name) continue;
      const variant = pick(seg,/<div class="description"[^>]*>([^<]+)<\/div>/i) ?? "";
      dbg.push({
        name:name.trim(),
        variant:variant.trim(),
        cornerFound:hasCornerPic(seg)
      });
    }
  }
  return dedupe(dbg);
}

/* ========= Helpers ========= */
const pick=(s,r)=>(s.match(r)||[])[1]||null;
const toNum=v=>Number(String(v).replace(/\./g,"").replace(/[^\d]/g,""));
const slug=s=>s.toLowerCase().replace(/[^a-z0-9]+/g,"-");
const fmt = n => `Rp${Number(n).toLocaleString("id-ID")}`;
const hash = s => { let h=2166136261; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619);} return (h>>>0).toString(16); };

async function fetchHtml(u){try{const r=await fetch(u,{headers:{ "User-Agent":"Mozilla/5.0"}});return r.ok?await r.text():"";}catch{return"";}}
async function fetchJson(u){try{const r=await fetch(u,{headers:{ "User-Agent":"Mozilla/5.0"}});return r.ok?await r.json():null;}catch{return null;}}

/* ========= Telegram Secure ========= */
async function sendTG(env, msg) {
  const token = env.TG_BOT;
  const chat  = env.TG_CHAT;
  if (!token || !chat) {
    console.warn("⚠️ Missing Telegram credentials in env");
    return;
  }

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ chat_id:chat, text:msg })
    });
  } catch (err) {
    console.error("Telegram send failed:", err);
  }
}

function json(obj,s=200){
  return new Response(JSON.stringify(obj,null,2),{
    status:s,
    headers:{ "Content-Type":"application/json" }
  });
}

function formatMsg(isNew,priceDrop,restock,p) {
  const title=isNew?"🆕 Baru!":priceDrop?"🔥 Turun Harga!":"✅ Restock!";
  const priceLine=p.salePrice!=null?`💰 ${fmt(p.salePrice)}`:"💰 ?";
  return `${title}
${p.name}
${p.variant}
${priceLine}
📦 ${p.stockLabel}
🔗 ${p.url}`;
}
