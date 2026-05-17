// api/prices.js — v4.1.0
// Searches Open Food Facts with Hebrew + English, prefers Israeli products

const HE_EN={'חלב':'milk','חלב 3%':'milk 3%','חלב 1%':'milk 1%','חלב עיזים':'goat milk',
  'גבינה':'cheese','גבינה לבנה':'white cheese',"קוטג'":'cottage cheese','קוטג':'cottage cheese',
  'שמנת':'cream','יוגורט':'yogurt','חמאה':'butter','לחם':'bread','פיתה':'pita',
  'קמח':'flour','ביצים':'eggs','ביצה':'egg','קורנפלקס':'cornflakes',
  'שיבולת שועל':'oatmeal','גרנולה':'granola','אורז':'rice','פסטה':'pasta',
  'ספגטי':'spaghetti','מקרוני':'macaroni','שמן':'oil','שמן זית':'olive oil',
  'שמן חמניות':'sunflower oil','סוכר':'sugar','דבש':'honey','מלח':'salt',
  'טחינה':'tahini','חומוס':'hummus','קטשופ':'ketchup','מיונז':'mayonnaise',
  'טונה':'tuna','קפה':'coffee','תה':'tea','מיץ':'juice','מים':'water',
  'שוקולד':'chocolate','עוגיות':'cookies','במבה':'bamba','ביסלי':'bisli',
  'גלידה':'ice cream','עוף':'chicken','בשר טחון':'ground beef',
  'עגבניות':'tomatoes','מלפפון':'cucumber','בצל':'onion','שום':'garlic',
  'גזר':'carrot','תפוח אדמה':'potato','ברוקולי':'broccoli',
  'תפוח':'apple','בננה':'banana','תפוז':'orange','לימון':'lemon',
  'נייר טואלט':'toilet paper','סבון':'soap','שמפו':'shampoo',
  'אבקת כביסה':'laundry detergent','נוזל כלים':'dish soap'};

const isHebrew=s=>/[\u0590-\u05FF]/.test(s);
const translate=q=>{const l=q.trim();if(HE_EN[l])return HE_EN[l];
  for(const[h,e]of Object.entries(HE_EN))if(l.includes(h)||h.includes(l))return e;return null;};

const OFF_BASE='https://world.openfoodfacts.org/cgi/search.pl';
const OFF_FIELDS='product_name,product_name_he,brands,quantity,image_small_url,code,countries_tags';

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS')return res.status(200).end();

  const q=String(req.query?.q||'').trim();
  const barcode=String(req.query?.barcode||'').replace(/\D/g,'');

  if(barcode&&barcode.length>=4){
    const prices=await getFirebasePrices(barcode);
    return res.status(200).json({version:'4.1.0',barcode,source:prices.length?'official':'none',prices});
  }

  if(!q||q.length<2)
    return res.status(400).json({error:'Provide ?q= or ?barcode='});

  const hebrew=isHebrew(q);
  const en=hebrew?(translate(q)||q):q;
  console.log(`[v4.1.0] "${q}" -> "${en}"`);

  try{
    const products=await searchOFF(q, en, hebrew);
    const enriched=await Promise.all(products.map(async p=>{
      if(!p.barcode)return{...p,storePrices:[],priceSource:'none'};
      const prices=await getFirebasePrices(p.barcode);
      return{...p,storePrices:prices,priceSource:prices.length?'official':'none'};
    }));
    enriched.sort((a,b)=>(b.storePrices?.length||0)-(a.storePrices?.length||0));
    return res.status(200).json({version:'4.1.0',query:q,englishQuery:en,results:enriched.slice(0,20),total:enriched.length});
  }catch(e){
    console.error('[prices v4.1]',e.message);
    return res.status(200).json({version:'4.1.0',query:q,results:[],error:e.message});
  }
}

async function searchOFF(hebrewQuery, englishQuery, isHeb){
  const seen=new Set();
  const results=[];

  // Build search URLs — prioritize Israeli products
  const searches=[
    // 1. Israeli products in English
    `${OFF_BASE}?search_terms=${encodeURIComponent(englishQuery)}&search_simple=1&action=process&json=1&page_size=10&fields=${OFF_FIELDS}&tagtype_0=countries&tag_contains_0=contains&tag_0=israel`,
    // 2. Hebrew product name search
    isHeb ? `${OFF_BASE}?search_terms=${encodeURIComponent(hebrewQuery)}&search_simple=1&action=process&json=1&page_size=8&fields=${OFF_FIELDS}` : null,
    // 3. Global English fallback (filtered by having Hebrew name)
    `${OFF_BASE}?search_terms=${encodeURIComponent(englishQuery)}&search_simple=1&action=process&json=1&page_size=15&fields=${OFF_FIELDS}`,
  ].filter(Boolean);

  for(const url of searches){
    try{
      const r=await fetch(url,{headers:{'User-Agent':'FamilyShoppingIL/4.1'},signal:AbortSignal.timeout(10000)});
      if(!r.ok)continue;
      const data=await r.json();
      for(const p of data?.products||[]){
        const code=p.code||'';
        if(code&&seen.has(code))continue;
        if(code)seen.add(code);
        // Prefer products with Hebrew name or from Israel
        const name=p.product_name_he||p.product_name||'';
        if(!name)continue;
        const isIsraeli=(p.countries_tags||[]).some(c=>c.includes('israel'));
        const hasHebrew=!!p.product_name_he;
        results.push({
          name,brand:p.brands||'',size:p.quantity||'',
          image:p.image_small_url||'',barcode:code,
          isIsraeli,hasHebrew,storePrices:[]
        });
      }
    }catch(e){console.warn('OFF error:',e.message);}
  }

  // Sort: Israeli first, then Hebrew name, then rest
  results.sort((a,b)=>{
    if(a.isIsraeli&&!b.isIsraeli)return -1;
    if(!a.isIsraeli&&b.isIsraeli)return 1;
    if(a.hasHebrew&&!b.hasHebrew)return -1;
    if(!a.hasHebrew&&b.hasHebrew)return 1;
    return 0;
  });

  return results.slice(0,12);
}

async function getFirebasePrices(barcode){
  try{
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
  }catch(e){console.warn('[firebase]',e.message);return[];}
}
