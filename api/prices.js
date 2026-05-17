// api/prices.js — v5.0.0
// Uses il-supermarket-searcher (open source Israeli price aggregator)
// + Open Food Facts for product metadata + images
// Falls back gracefully if aggregator unavailable

const HE_EN = {
  'חלב':'milk','חלב 3%':'milk 3%','חלב 1%':'milk 1%','חלב עיזים':'goat milk',
  'גבינה':'cheese','גבינה לבנה':'white cheese',"קוטג'":'cottage cheese','קוטג':'cottage cheese',
  'שמנת':'cream','יוגורט':'yogurt','חמאה':'butter','לחם':'bread','פיתה':'pita',
  'קמח':'flour','ביצים':'eggs','ביצה':'egg','קורנפלקס':'cornflakes',
  'שיבולת שועל':'oatmeal','גרנולה':'granola','אורז':'rice','פסטה':'pasta',
  'ספגטי':'spaghetti','מקרוני':'macaroni','שמן':'oil','שמן זית':'olive oil',
  'שמן חמניות':'sunflower oil','סוכר':'sugar','דבש':'honey','מלח':'salt',
  'טחינה':'tahini','חומוס':'hummus','קטשופ':'ketchup','מיונז':'mayonnaise',
  'טונה':'tuna','קפה':'coffee','קפה נמס':'instant coffee','תה':'tea',
  'מיץ':'juice','מים':'water','קולה':'cola','שוקולד':'chocolate',
  'עוגיות':'cookies','במבה':'bamba','ביסלי':'bisli','גלידה':'ice cream',
  'עוף':'chicken','בשר טחון':'ground beef','עגבניות':'tomatoes',
  'מלפפון':'cucumber','בצל':'onion','שום':'garlic','גזר':'carrot',
  'תפוח אדמה':'potato','ברוקולי':'broccoli','תפוח':'apple','בננה':'banana',
  'תפוז':'orange','לימון':'lemon','נייר טואלט':'toilet paper',
  'סבון':'soap','שמפו':'shampoo','אבקת כביסה':'laundry detergent',
  'נוזל כלים':'dish soap',
};

const isHebrew = s => /[\u0590-\u05FF]/.test(s);
const translate = q => {
  const l = q.trim();
  if (HE_EN[l]) return HE_EN[l];
  for (const [h,e] of Object.entries(HE_EN)) if (l.includes(h)||h.includes(l)) return e;
  return null;
};

// Israeli price aggregator — runs on Israeli servers, has access to supermarket XML
const IL_SEARCHER = 'https://il-supermarket-searcher.onrender.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();

  const q = String(req.query?.q||'').trim();
  const barcode = String(req.query?.barcode||'').replace(/\D/g,'');

  // Barcode lookup
  if (barcode && barcode.length >= 4) {
    const [fbPrices, ilPrices] = await Promise.allSettled([
      getFirebasePrices(barcode),
      getILSearcherPrices(barcode),
    ]);
    const prices = [
      ...(fbPrices.status==='fulfilled' ? fbPrices.value : []),
      ...(ilPrices.status==='fulfilled' ? ilPrices.value : []),
    ].sort((a,b) => a.price - b.price);
    return res.status(200).json({ version:'5.0.0', barcode, source: prices.length?'official':'none', prices });
  }

  if (!q || q.length < 2)
    return res.status(400).json({ error: 'Provide ?q= or ?barcode=' });

  const english = isHebrew(q) ? (translate(q)||q) : q;
  console.log(`[v5.0.0] "${q}" → "${english}"`);

  try {
    // 1. Search Open Food Facts for product metadata + images
    const offProducts = await searchOFF(q, english);

    // 2. Search IL aggregator for live prices by product name
    const ilResults = await searchILSearcher(q, english);

    // 3. Enrich OFF products with Firebase prices
    const enriched = await Promise.all(offProducts.map(async p => {
      if (!p.barcode) return {...p, storePrices:[], priceSource:'none'};
      const [fbP, ilP] = await Promise.allSettled([
        getFirebasePrices(p.barcode),
        getILSearcherPrices(p.barcode),
      ]);
      const storePrices = [
        ...(fbP.status==='fulfilled' ? fbP.value : []),
        ...(ilP.status==='fulfilled' ? ilP.value : []),
      ].sort((a,b) => a.price - b.price);
      return {...p, storePrices, priceSource: storePrices.length?'official':'none'};
    }));

    // 4. Add IL-only results (have prices but not in OFF)
    const offBarcodes = new Set(offProducts.map(p=>p.barcode).filter(Boolean));
    const ilOnly = ilResults.filter(r => r.barcode && !offBarcodes.has(r.barcode));

    const all = [...enriched, ...ilOnly]
      .sort((a,b) => (b.storePrices?.length||0) - (a.storePrices?.length||0));

    return res.status(200).json({
      version:'5.0.0', query:q, englishQuery:english,
      results: all.slice(0,20), total: all.length,
    });

  } catch(e) {
    console.error('[v5]', e.message);
    return res.status(200).json({ version:'5.0.0', query:q, results:[], error:e.message });
  }
}

// ── IL Supermarket Searcher ──
async function searchILSearcher(heQuery, enQuery) {
  try {
    const q = isHebrew(heQuery) ? heQuery : enQuery;
    const res = await fetch(
      `${IL_SEARCHER}/products?query=${encodeURIComponent(q)}&limit=20`,
      { headers:{'User-Agent':'FamilyShoppingIL/5.0','Accept':'application/json'}, signal:AbortSignal.timeout(12000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const items = data?.products || data?.results || (Array.isArray(data)?data:[]);
    return items.map(item => ({
      name: item.name||item.ItemName||'',
      brand: item.ManufacturerName||item.brand||'',
      size: item.Quantity||item.size||'',
      image: item.image||'',
      barcode: String(item.ItemCode||item.barcode||''),
      storePrices: buildStorePrices(item),
      priceSource: 'official',
    })).filter(p=>p.name);
  } catch(e) { console.warn('[IL searcher]', e.message); return []; }
}

async function getILSearcherPrices(barcode) {
  try {
    const res = await fetch(
      `${IL_SEARCHER}/products?query=${barcode}&limit=5`,
      { headers:{'Accept':'application/json'}, signal:AbortSignal.timeout(8000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const items = data?.products || data?.results || (Array.isArray(data)?data:[]);
    const match = items.find(i => String(i.ItemCode||i.barcode||'') === barcode);
    if (!match) return [];
    return buildStorePrices(match);
  } catch(e) { return []; }
}

function buildStorePrices(item) {
  const chains = item.chains || item.prices || item.stores || [];
  if (!Array.isArray(chains)||!chains.length) {
    if (item.ItemPrice||item.price) {
      return [{ store: mapChain(item.ChainID||item.chain_id||''), price: parseFloat(item.ItemPrice||item.price||0), unit:'', source:'official' }].filter(p=>p.price>0&&p.store);
    }
    return [];
  }
  return chains.map(c => ({
    store: mapChain(c.ChainID||c.chain_id||c.name||c.store||''),
    price: parseFloat(c.ItemPrice||c.price||0),
    unit: c.UnitQty||item.UnitQty||'',
    source: 'official',
  })).filter(p=>p.price>0&&p.store).sort((a,b)=>a.price-b.price);
}

const CHAIN_MAP = {
  '7290027600007':'שופרסל','7290058140886':'רמי לוי','7290696200003':'ויקטורי',
  '7290873255550':'יינות ביתן','7290055755557':'מחסני להב','7290058179504':'אושר עד',
};
function mapChain(id) {
  const s=String(id||'');
  for(const[k,v]of Object.entries(CHAIN_MAP))if(s.includes(k))return v;
  const l=s.toLowerCase();
  if(l.includes('shufersal')||l.includes('שופרסל'))return'שופרסל';
  if(l.includes('rami')||l.includes('רמי'))return'רמי לוי';
  if(l.includes('victory')||l.includes('ויקטורי'))return'ויקטורי';
  if(l.includes('yeinot')||l.includes('יינות'))return'יינות ביתן';
  if(l.includes('osher')||l.includes('אושר'))return'אושר עד';
  if(l.includes('lahav')||l.includes('להב'))return'מחסני להב';
  return s||'';
}

// ── Firebase prices (from future XML sync when it works) ──
async function getFirebasePrices(barcode) {
  try {
    const sa=process.env.FIREBASE_SERVICE_ACCOUNT;
    const url=process.env.FIREBASE_DATABASE_URL;
    if(!sa||!url)return[];
    const{initializeApp,cert,getApps}=await import('firebase-admin/app');
    const{getDatabase}=await import('firebase-admin/database');
    if(!getApps().length)initializeApp({credential:cert(JSON.parse(sa)),databaseURL:url});
    const db=getDatabase();
    const snap=await db.ref(`prices/${barcode}`).get();
    if(!snap.exists())return[];
    return Object.values(snap.val()).filter(p=>p?.price>0)
      .map(p=>({store:p.chainName||p.chainId||'סופר',price:p.price,unit:p.unit||'',updatedAt:p.updatedAt||'',source:'official'}))
      .sort((a,b)=>a.price-b.price);
  }catch(e){return[];}
}

// ── Open Food Facts ──
async function searchOFF(heQuery, enQuery) {
  const seen=new Set(), results=[];
  const searches=[
    `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(enQuery)}&search_simple=1&action=process&json=1&page_size=8&fields=product_name,product_name_he,brands,quantity,image_small_url,code,countries_tags&tagtype_0=countries&tag_contains_0=contains&tag_0=israel`,
    `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(heQuery)}&search_simple=1&action=process&json=1&page_size=6&fields=product_name,product_name_he,brands,quantity,image_small_url,code`,
    `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(enQuery)}&search_simple=1&action=process&json=1&page_size=10&fields=product_name,product_name_he,brands,quantity,image_small_url,code,countries_tags`,
  ];
  for(const url of searches){
    try{
      const r=await fetch(url,{headers:{'User-Agent':'FamilyShoppingIL/5.0'},signal:AbortSignal.timeout(10000)});
      if(!r.ok)continue;
      const data=await r.json();
      for(const p of data?.products||[]){
        const code=p.code||'';
        if(code&&seen.has(code))continue;
        if(code)seen.add(code);
        const name=p.product_name_he||p.product_name||'';
        if(!name)continue;
        const isIsraeli=(p.countries_tags||[]).some(c=>c.includes('israel'));
        results.push({name,brand:p.brands||'',size:p.quantity||'',image:p.image_small_url||'',barcode:code,isIsraeli,storePrices:[]});
      }
      if(results.length>=10)break;
    }catch(e){}
  }
  results.sort((a,b)=>(b.isIsraeli?1:0)-(a.isIsraeli?1:0));
  return results.slice(0,12);
}
