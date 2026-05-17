// api/prices.js — v4.0.0 — NO Firebase dependency, Open Food Facts only
// Firebase prices added later once sync job runs

const HE_EN={'חלב':'milk','חלב 3%':'milk 3%','חלב 1%':'milk 1%','חלב עיזים':'goat milk',
  'גבינה':'cheese','גבינה לבנה':'white cheese',"קוטג'":'cottage cheese','קוטג':'cottage cheese',
  'שמנת':'cream','יוגורט':'yogurt','יוגורט יווני':'greek yogurt','חמאה':'butter',
  'לחם':'bread','פיתה':'pita','קמח':'flour','ביצים':'eggs','ביצה':'egg',
  'קורנפלקס':'cornflakes','שיבולת שועל':'oatmeal','גרנולה':'granola',
  'אורז':'rice','פסטה':'pasta','ספגטי':'spaghetti','מקרוני':'macaroni',
  'שמן':'oil','שמן זית':'olive oil','שמן חמניות':'sunflower oil',
  'סוכר':'sugar','דבש':'honey','מלח':'salt','טחינה':'tahini','חומוס':'hummus',
  'קטשופ':'ketchup','מיונז':'mayonnaise','טונה':'tuna',
  'קפה':'coffee','קפה נמס':'instant coffee','תה':'tea',
  'מיץ':'juice','מים':'water','קולה':'cola',
  'שוקולד':'chocolate','עוגיות':'cookies','במבה':'bamba','ביסלי':'bisli',
  'גלידה':'ice cream','עוף':'chicken','בשר טחון':'ground beef',
  'עגבניות':'tomatoes','מלפפון':'cucumber','בצל':'onion','שום':'garlic',
  'גזר':'carrot','תפוח אדמה':'potato','ברוקולי':'broccoli',
  'תפוח':'apple','בננה':'banana','תפוז':'orange','לימון':'lemon',
  'נייר טואלט':'toilet paper','סבון':'soap','שמפו':'shampoo',
  'אבקת כביסה':'laundry detergent','נוזל כלים':'dish soap'};

const isHebrew=s=>/[\u0590-\u05FF]/.test(s);
const translate=q=>{const l=q.trim();if(HE_EN[l])return HE_EN[l];for(const[h,e]of Object.entries(HE_EN))if(l.includes(h)||h.includes(l))return e;return null;};

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS')return res.status(200).end();

  const q=String(req.query?.q||'').trim();
  const barcode=String(req.query?.barcode||'').replace(/\D/g,'');

  if(barcode&&barcode.length>=4){
    // Firebase price lookup by barcode
    const prices=await getFirebasePrices(barcode);
    return res.status(200).json({version:'4.0.0',barcode,source:prices.length?'official':'none',prices});
  }

  if(!q||q.length<2)
    return res.status(400).json({error:'Provide ?q= or ?barcode='});

  const hebrew=isHebrew(q);
  const en=hebrew?(translate(q)||q):q;
  console.log(`[v4.0.0] "${q}" -> "${en}"`);

  try{
    const products=await searchOFF(en);
    // Enrich with Firebase prices if available
    const enriched=await Promise.all(products.map(async p=>{
      if(!p.barcode)return{...p,storePrices:[],priceSource:'none'};
      const prices=await getFirebasePrices(p.barcode);
      return{...p,storePrices:prices,priceSource:prices.length?'official':'none'};
    }));
    enriched.sort((a,b)=>(b.storePrices?.length||0)-(a.storePrices?.length||0));
    return res.status(200).json({version:'4.0.0',query:q,englishQuery:en,results:enriched.slice(0,20),total:enriched.length});
  }catch(e){
    console.error('[prices v4]',e.message);
    return res.status(200).json({version:'4.0.0',query:q,results:[],error:e.message});
  }
}

async function getFirebasePrices(barcode){
  try{
    const sa=process.env.FIREBASE_SERVICE_ACCOUNT;
    const url=process.env.FIREBASE_DATABASE_URL;
    if(!sa||!url)return[];
    const {initializeApp,cert,getApps}=await import('firebase-admin/app');
    const {getDatabase}=await import('firebase-admin/database');
    if(!getApps().length)initializeApp({credential:cert(JSON.parse(sa)),databaseURL:url});
    const db=getDatabase();
    const snap=await db.ref(`prices/${barcode}`).get();
    if(!snap.exists())return[];
    return Object.values(snap.val()).filter(p=>p?.price>0)
      .map(p=>({store:p.chainName||p.chainId||'סופר',price:p.price,unit:p.unit||'',updatedAt:p.updatedAt||'',source:'official'}))
      .sort((a,b)=>a.price-b.price);
  }catch(e){console.warn('[firebase]',e.message);return[];}
}

async function searchOFF(query){
  // Search with country filter for Israel first, fallback to global
  const searches = [
    // Israeli products first
    `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=8&fields=product_name,product_name_he,brands,quantity,image_small_url,code&tagtype_0=countries&tag_contains_0=contains&tag_0=israel`,
    // Global fallback
    `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=12&fields=product_name,product_name_he,brands,quantity,image_small_url,code`
  ];

  const seen = new Set();
  const results = [];

  for(const url of searches){
    try{
      const res=await fetch(url,{headers:{'User-Agent':'FamilyShoppingIL/4.0'},signal:AbortSignal.timeout(10000)});
      if(!res.ok)continue;
      const data=await res.json();
      for(const p of data?.products||[]){
        const barcode=p.code||'';
        if(barcode&&seen.has(barcode))continue;
        if(barcode)seen.add(barcode);
        const name=p.product_name_he||p.product_name||'';
        if(name.length<1)continue;
        results.push({name,brand:p.brands||'',size:p.quantity||'',image:p.image_small_url||'',barcode,storePrices:[]});
      }
      if(results.length>=8)break; // enough results
    }catch(e){console.warn('OFF search error:',e.message);}
  }
  return results.slice(0,12);
}
