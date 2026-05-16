// api/prices.js
// v2.0.0 — Hebrew translation layer + Open Food Facts + Israeli gov price aggregators
// CHANGELOG:
//   v1.0.0 — initial version (supermarket direct fetch, blocked by CORS)
//   v2.0.0 — Hebrew→English translation dictionary, dual OFF search, gov price APIs

const HE_EN = {
  'חלב':'milk','חלב טרי':'fresh milk','חלב מלא':'whole milk',
  'חלב 3%':'milk 3%','חלב 1%':'milk 1%','חלב עיזים':'goat milk',
  'חלב שוקולד':'chocolate milk','חלב ללא לקטוז':'lactose free milk',
  'גבינה':'cheese','גבינה לבנה':'white cheese','גבינה צהובה':'yellow cheese',
  'גבינת עיזים':'goat cheese','גבינת שמנת':'cream cheese',
  'קוטג':"cottage cheese","קוטג'":'cottage cheese',
  'שמנת':'cream','שמנת חמוצה':'sour cream','יוגורט':'yogurt',
  'יוגורט יווני':'greek yogurt','חמאה':'butter','מרגרינה':'margarine',
  'לחם':'bread','לחם אחיד':'whole wheat bread','לחם מלא':'whole grain bread',
  'פיתה':'pita','חלה':'challah','לחמניות':'rolls','בגט':'baguette',
  'קמח':'flour','קמח מלא':'whole wheat flour','שמרים':'yeast',
  'ביצים':'eggs','ביצה':'egg','ביצים חופשיות':'free range eggs',
  'קורנפלקס':'cornflakes','שיבולת שועל':'oatmeal','גרנולה':'granola',
  'אורז':'rice','אורז מלא':'brown rice','אורז בסמטי':'basmati rice',
  'פסטה':'pasta','ספגטי':'spaghetti','מקרוני':'macaroni','פנה':'penne',
  'שמן':'oil','שמן זית':'olive oil','שמן חמניות':'sunflower oil',
  'סוכר':'sugar','סוכר חום':'brown sugar','דבש':'honey',
  'מלח':'salt','פלפל שחור':'black pepper','כמון':'cumin',
  'פפריקה':'paprika','כורכום':'turmeric','קינמון':'cinnamon',
  'טחינה':'tahini','חומוס':'hummus','קטשופ':'ketchup',
  'מיונז':'mayonnaise','חרדל':'mustard',
  'טונה':'tuna','סרדינים':'sardines',
  'קפה':'coffee','קפה נמס':'instant coffee','אספרסו':'espresso',
  'תה':'tea','תה ירוק':'green tea',
  'מיץ':'juice','מיץ תפוזים':'orange juice','מיץ תפוחים':'apple juice',
  'מים':'water','סודה':'soda water','קולה':'cola',
  'שוקולד':'chocolate','עוגיות':'cookies','ביסקוויט':'biscuit',
  'במבה':'bamba','ביסלי':'bisli','גלידה':'ice cream',
  'עוף':'chicken','חזה עוף':'chicken breast','בשר טחון':'ground beef',
  'קציצות':'meatballs','נקניק':'sausage',
  'עגבניות':'tomatoes','מלפפון':'cucumber','בצל':'onion','שום':'garlic',
  'גזר':'carrot','תפוח אדמה':'potato','ברוקולי':'broccoli',
  'חסה':'lettuce','תרד':'spinach','פטריות':'mushrooms',
  'תפוח':'apple','בננה':'banana','תפוז':'orange','לימון':'lemon',
  'ענבים':'grapes','אבטיח':'watermelon','תות':'strawberry','מנגו':'mango',
  'נייר טואלט':'toilet paper','מגבות נייר':'paper towels',
  'סבון':'soap','שמפו':'shampoo','אבקת כביסה':'laundry detergent',
  'נוזל כלים':'dish soap','שקיות זבל':'garbage bags',
};

function isHebrew(s){ return /[\u0590-\u05FF]/.test(s); }

function translateHebrew(q) {
  const lower = q.trim();
  if (HE_EN[lower]) return HE_EN[lower];
  for (const [he, en] of Object.entries(HE_EN)) {
    if (lower.includes(he) || he.includes(lower)) return en;
  }
  return null; // no translation found
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const query = (req.query?.q || '').trim();
  if (!query || query.length < 2)
    return res.status(400).json({ error: 'חסר פרמטר חיפוש' });

  const hebrew = isHebrew(query);
  const englishQuery = hebrew ? (translateHebrew(query) || query) : query;
  const translated = hebrew && englishQuery !== query;

  console.log(`[v2.0.0] "${query}" → "${englishQuery}" (translated: ${translated})`);

  // Search Open Food Facts with both Hebrew and English in parallel
  const searches = [searchOFF(englishQuery)];
  if (translated) searches.push(searchOFF(query)); // also try Hebrew directly

  const [offEn, offHe] = await Promise.allSettled(searches);

  const seenBarcodes = new Set();
  const offProducts = [];
  for (const r of [offEn, offHe]) {
    if (r?.status !== 'fulfilled') continue;
    for (const p of r.value) {
      if (p.barcode && seenBarcodes.has(p.barcode)) continue;
      if (p.barcode) seenBarcodes.add(p.barcode);
      offProducts.push(p);
    }
  }

  // Try gov price aggregators
  const [govRes] = await Promise.allSettled([searchGovPrices(englishQuery)]);
  const govPrices = govRes?.status === 'fulfilled' ? govRes.value : [];

  console.log(`OFF: ${offProducts.length} products | Gov prices: ${govPrices.length}`);

  // Enrich OFF products with gov prices
  const results = offProducts.map(p => ({
    ...p,
    storePrices: govPrices.filter(g =>
      nameSimilarity(g.name, p.name) > 0.3 ||
      (p.barcode && g.barcode && p.barcode === g.barcode)
    )
  }));

  // Add gov-only price groups not matched to OFF
  const matched = new Set(
    govPrices
      .filter(g => offProducts.some(p => nameSimilarity(g.name, p.name) > 0.3))
      .map(g => g.name.toLowerCase())
  );
  const groups = {};
  govPrices.filter(g => !matched.has(g.name.toLowerCase())).forEach(g => {
    const key = g.name.toLowerCase().substring(0, 50);
    if (!groups[key]) groups[key] = { name:g.name, brand:g.brand||'', size:g.size||'', image:'', barcode:g.barcode||'', storePrices:[] };
    groups[key].storePrices.push({ store:g.store, price:g.price, unit:g.unit||'' });
  });
  results.push(...Object.values(groups));
  results.sort((a,b) => (b.storePrices?.length||0) - (a.storePrices?.length||0));

  return res.status(200).json({
    version: '2.0.0',
    query, englishQuery, translated,
    results: results.slice(0, 20),
    total: results.length,
  });
}

async function searchOFF(query) {
  try {
    const url = `https://world.openfoodfacts.org/cgi/search.pl?` +
      `search_terms=${encodeURIComponent(query)}&search_simple=1&action=process` +
      `&json=1&page_size=10&fields=product_name,product_name_he,brands,quantity,image_small_url,code`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'FamilyShoppingIL/2.0 (github.com/Ezbyname/family-shopping)' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.products || [])
      .map(p => ({
        name: p.product_name_he || p.product_name || '',
        brand: p.brands || '',
        size: p.quantity || '',
        image: p.image_small_url || '',
        barcode: p.code || '',
        storePrices: [],
      }))
      .filter(p => p.name.length > 1);
  } catch(e) { console.log('OFF error:', e.message); return []; }
}

async function searchGovPrices(query) {
  const [r1, r2] = await Promise.allSettled([
    fetchPricez(query),
    fetchOpenIsrael(query),
  ]);
  return [
    ...(r1.status === 'fulfilled' ? r1.value : []),
    ...(r2.status === 'fulfilled' ? r2.value : []),
  ];
}

async function fetchPricez(query) {
  try {
    const res = await fetch(
      `https://www.pricez.co.il/api/search?q=${encodeURIComponent(query)}&limit=20`,
      { headers:{'User-Agent':'FamilyShoppingIL/2.0','Accept':'application/json'}, signal:AbortSignal.timeout(9000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const items = data?.products || data?.results || data?.items || (Array.isArray(data)?data:[]);
    const out = [];
    items.forEach(item => {
      const name = item.name || item.product_name || '';
      if (!name) return;
      const prices = item.prices || item.stores || [];
      if (Array.isArray(prices) && prices.length) {
        prices.forEach(p => {
          const store = mapStore(p.store_id || p.chain_id || p.store_name || '');
          if (!store) return;
          out.push({ name, store, price: parseFloat(p.price||p.item_price||0),
            unit: p.unit_qty||item.unit_qty||'', brand: item.manufacturer_name||item.brand||'',
            size: item.quantity||'', barcode: item.barcode||item.item_code||'' });
        });
      }
    });
    return out.filter(r => r.price > 0);
  } catch(e) { console.log('pricez error:', e.message); return []; }
}

async function fetchOpenIsrael(query) {
  try {
    const res = await fetch(
      `https://il-supermarket-searcher.onrender.com/products?query=${encodeURIComponent(query)}&limit=20`,
      { headers:{'User-Agent':'FamilyShoppingIL/2.0','Accept':'application/json'}, signal:AbortSignal.timeout(10000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const items = data?.products || data?.results || (Array.isArray(data)?data:[]);
    const out = [];
    items.forEach(item => {
      const name = item.name || item.ItemName || '';
      if (!name) return;
      const chains = item.chains || item.prices || item.stores || [];
      if (Array.isArray(chains) && chains.length) {
        chains.forEach(c => {
          const store = mapStore(c.ChainID||c.chain_id||c.store||c.name||'');
          out.push({ name, store: store||c.name||'סופר',
            price: parseFloat(c.ItemPrice||c.price||0),
            unit: item.UnitQty||'', brand: item.ManufacturerName||'',
            size: item.Quantity||'', barcode: item.ItemCode||item.barcode||'' });
        });
      } else {
        const store = mapStore(item.chain_id||item.ChainID||'');
        out.push({ name, store: store||'סופר',
          price: parseFloat(item.ItemPrice||item.price||0),
          unit: item.UnitQty||'', brand: item.ManufacturerName||'',
          size: item.Quantity||'', barcode: item.ItemCode||item.barcode||'' });
      }
    });
    return out.filter(r => r.price > 0 && r.name);
  } catch(e) { console.log('open-israel error:', e.message); return []; }
}

const CHAIN_MAP = {
  '7290027600007':'שופרסל','7290058140886':'רמי לוי','7290696200003':'ויקטורי',
  '7290873255550':'יינות ביתן','7290055755557':'מחסני להב','7290058179504':'אושר עד',
};
function mapStore(id) {
  const s = String(id||'');
  for (const [cid, name] of Object.entries(CHAIN_MAP)) { if (s.includes(cid)) return name; }
  const lc = s.toLowerCase();
  if (lc.includes('shufersal')||lc.includes('שופרסל')) return 'שופרסל';
  if (lc.includes('rami')||lc.includes('רמי')) return 'רמי לוי';
  if (lc.includes('victory')||lc.includes('ויקטורי')) return 'ויקטורי';
  if (lc.includes('yeinot')||lc.includes('יינות')) return 'יינות ביתן';
  if (lc.includes('mahsanei')||lc.includes('מחסני')) return 'מחסני להב';
  if (lc.includes('osher')||lc.includes('אושר')) return 'אושר עד';
  return '';
}

function nameSimilarity(a, b) {
  if (!a||!b) return 0;
  a = a.toLowerCase().trim(); b = b.toLowerCase().trim();
  if (a===b) return 1;
  if (a.includes(b)||b.includes(a)) return 0.8;
  const wa = new Set(a.split(/[\s\-,]+/).filter(w=>w.length>1));
  const wb = new Set(b.split(/[\s\-,]+/).filter(w=>w.length>1));
  const inter = [...wa].filter(w=>wb.has(w)).length;
  const union = new Set([...wa,...wb]).size;
  return union>0 ? inter/union : 0;
}
