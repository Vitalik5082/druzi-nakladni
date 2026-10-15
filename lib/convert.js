const VAT_RATE = 1.2;

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/мс\s*/g, '')
    .replace(/т\/м/g, '')
    .replace(/[^a-zа-яіїє0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Plain .includes() lets a short key match as a substring inside an unrelated word — "ФІН"
// (Finlandia vodka) was matching inside "раФІНована" (refined), reclassifying sunflower oil as
// alcohol-by-the-shot. Require the match not be flanked by another letter/digit on either side.
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function includesWord(text, key) {
  return new RegExp(`(?<![A-ZА-ЯІЇЄ0-9])${escapeRegex(key)}(?![A-ZА-ЯІЇЄ0-9])`, 'i').test(text);
}

function matchKeys(texts, arr) {
  return arr.find(r => texts.some(t => includesWord(t, r.key)));
}

function hasAny(texts, words) {
  return words.some(w => texts.some(t => includesWord(t, w)));
}

// Matches an OCR/AI-guessed supplier name against the saved list — exact first, then substring
// either direction, then falling back to a shared significant word (e.g. a surname): "ФОП
// Проценко Олена Михайлівна" vs "Проценко/Плахотнік" share "проценко" but neither string contains
// the other, so without this a накладна with the full legal name always created a duplicate
// supplier instead of matching the existing one.
function findSupplier(suppliers, guessName) {
  if (!guessName) return null;
  const key = normalize(guessName);
  let match = suppliers.find(s => normalize(s.name) === key);
  if (!match) match = suppliers.find(s => key.includes(normalize(s.name)) || normalize(s.name).includes(key));
  if (!match) {
    const guessWords = key.split(' ').filter(w => w.length >= 5);
    match = suppliers.find(s => {
      const supplierWords = normalize(s.name).split(' ').filter(w => w.length >= 5);
      return supplierWords.some(w => guessWords.includes(w));
    });
  }
  return match || null;
}

const BOTTLE_HINTS = ['БУТ', 'БУТИЛ', 'БАНК', 'CAN', 'Ж/Б', 'ЖБ'];
const KEG_HINTS = ['КЕГ', 'БОЧК'];

const ALL_ALCOHOL = ["ГОРІЛКА","VODKA","ТЕКІЛА","TEQUILA","ВІСКІ","WHISKEY","WHISKY",
  "КОНЬЯК","BRANDY","ДЖИН","GIN","ЛІКЕР","LIQUEUR","БУРБОН","BOURBON",
  "ДЖЕК","JACK","ФІН","FIN","ДЖЕЙМСОН","JAMESON","МАЛІБУ","MALIBU",
  "МОРГАН","MORGAN","БЕЙЛІЗ","BAILEYS","JAGERMEISTER","ЯГЕР",
  "АБСЕНТ","ABSINTH","САМБУКА","SAMBUCA","МАРТІНІ","MARTINI",
  "БАЛАНТ","BALLANT","ВАЙТХОРС","БАКАРДІ","BACARDI","ТЕК ІЛА",
  "ШАМП","РОМА","ТРІПЛ СЕК"];

const PCS_ONLY = ['норі','nori','листи','листів','пакет','набір','пачк'];
const DEFAULT_BOTTLE_ML = 700;

// ── Classification: container cues (бут/банка vs кег/бочка) decide BEFORE brand rules ──
function getProductType(origName, mappedName, R) {
  const texts = [origName.toUpperCase(), mappedName.toUpperCase()];

  if (matchKeys(texts, R.alcohol_portions || [])) return 'alcohol_portion';
  if (matchKeys(texts, R.alcohol_ml || [])) return 'alcohol_ml';

  const isBottleOrCan = hasAny(texts, BOTTLE_HINTS);
  const isKeg = hasAny(texts, KEG_HINTS);

  if (isBottleOrCan) {
    if (matchKeys(texts, R.bottled_drinks || [])) return 'bottled';
    return 'bottled_generic';
  }

  if (isKeg && matchKeys(texts, R.draft_beer || [])) return 'draft_beer';
  if (!isKeg && matchKeys(texts, R.draft_beer || [])) return 'draft_beer';

  if (matchKeys(texts, R.food_portions || [])) return 'food_portion';
  if (matchKeys(texts, R.pcs_as_grams || [])) return 'pcs_as_grams';
  if (matchKeys(texts, R.pack_overrides || [])) return 'pack_override';
  if (matchKeys(texts, R.bottled_drinks || [])) return 'bottled';

  if (ALL_ALCOHOL.some(k => texts.some(t => includesWord(t, k)))) return 'alcohol_ml';
  return 'unknown';
}

function getPackSize(name) {
  const m = name.match(/[xXхХ×*]\s*(\d{2,3})\b/);
  return m ? parseInt(m[1]) : 1;
}

function getWeightFromName(name) {
  const r = name.match(/(\d{2,4})\s*\/\s*(\d{2,4})\s*(?:г|g)?(?:\s|$)/i);
  if (r) { const avg=(parseInt(r[1])+parseInt(r[2]))/2; if(avg>=50&&avg<=9999) return {g:avg,isMl:false}; }
  const dL = name.match(/(\d+[.,]\d+)\s*л(?:\s|$|[^а-яіїєa-z])/i);
  if (dL) return {g:parseFloat(dL[1].replace(',','.'))*1000, isMl:true};
  const wL = name.match(/(?<!\d)(\d{1,2})\s*л(?:\s|$|[^а-яіїєa-z])/i);
  if (wL) { const l=parseInt(wL[1]); if(l>=1&&l<=30) return {g:l*1000,isMl:true}; }
  const ml = name.match(/(\d{2,4})\s*мл/i);
  if (ml) { const v=parseInt(ml[1]); if(v>=50&&v<=9999) return {g:v,isMl:true}; }
  const dK = name.match(/(\d+[.,]\d+)\s*кг/i);
  if (dK) return {g:parseFloat(dK[1].replace(',','.'))*1000, isMl:false};
  const wK = name.match(/(?<![0-9,.])\s*(\d{1,3})\s*кг/i);
  if (wK) { const k=parseInt(wK[1]); if(k>=1&&k<=200) return {g:k*1000,isMl:false}; }
  const gr = name.match(/(\d{2,4})\s*г(?:\s|$|[^а-яіїєa-z])/i);
  if (gr) { const g=parseInt(gr[1]); if(g>=10&&g<=9999) return {g,isMl:false}; }
  return null;
}

function withVat(result) {
  result.price_with_vat = Number((result.price * VAT_RATE).toFixed(6));
  result.total_with_vat = Number((result.total * VAT_RATE).toFixed(2));
  if (result.price_per_g) result.price_per_g_with_vat = Number((result.price_per_g * VAT_RATE).toFixed(6));
  return result;
}

function convertItem(item, mappedName, portionRules, unitOverrides, idx) {
  const R = Object.assign({
    alcohol_portions: [], alcohol_ml: [], food_portions: [],
    pcs_as_grams: [], draft_beer: [], pack_overrides: [], bottled_drinks: []
  }, portionRules || {});

  const texts = [item.name.toUpperCase(), mappedName.toUpperCase()];
  const nameLower = item.name.toLowerCase();
  const unit = (item.unit || '').toLowerCase();
  const productType = getProductType(item.name, mappedName, R);

  const packSize = getPackSize(item.name);
  const effectiveQty = item.qty * packSize;
  const unitPrice = packSize > 1 ? item.price / packSize : item.price;
  const invoiceTotal = (item.qty || 0) * (item.price || 0);

  const base = {
    id: idx, original_name: item.name, name: mappedName,
    qty: item.qty, unit: item.unit || 'pcs',
    price: item.price || 0, price_per_g: 0, total: invoiceTotal,
    matched: mappedName !== item.name, skipped: false
  };

  let result;

  // ── ШТУЧНІ НАПОЇ (бут/банка): завжди рахуються штуками ────────────
  if (productType === 'bottled' || productType === 'bottled_generic') {
    result = { ...base, qty: effectiveQty, price: Number(unitPrice.toFixed(4)),
      packSize: packSize > 1 ? packSize : undefined };

  } else if (productType === 'pack_override') {
    const rule = matchKeys(texts, R.pack_overrides);
    const realQty = item.qty * rule.pcs_in_pack;
    const realUnitPrice = invoiceTotal / realQty;
    result = { ...base, qty: realQty, unit: 'pcs',
      price: Number(realUnitPrice.toFixed(4)),
      packSize: rule.pcs_in_pack };

  } else if (productType === 'pcs_as_grams') {
    const rule = matchKeys(texts, R.pcs_as_grams);
    const totalG = item.qty * rule.g_per_pcs;
    const ppg = invoiceTotal > 0 ? invoiceTotal / totalG : 0;
    result = { ...base, qty: totalG, unit: 'g', grams: totalG,
      price: Number(ppg.toFixed(6)), price_per_g: Number(ppg.toFixed(6)) };

  } else if (productType === 'draft_beer') {
    const rule = matchKeys(texts, R.draft_beer);
    const totalMlBeer = item.qty * rule.barrel_l * 1000;
    const portions = Math.floor(totalMlBeer / rule.portion_ml);
    const pportion = invoiceTotal > 0 ? invoiceTotal / portions : 0;
    result = { ...base, qty: portions, unit: 'portion', grams: totalMlBeer,
      price: Number(pportion.toFixed(4)),
      price_per_g: Number((invoiceTotal / totalMlBeer).toFixed(6)) };

  } else {
    let totalMl = 0, isMl = false, pricePerUnit = 0;

    if (unit === 'kg') {
      totalMl = item.qty * 1000; pricePerUnit = item.price / 1000;
    } else if (unit === 'g') {
      totalMl = item.qty; pricePerUnit = item.price;
    } else if (unit === 'l' || unit === 'л') {
      totalMl = item.qty * 1000; isMl = true;
      pricePerUnit = invoiceTotal > 0 ? invoiceTotal / totalMl : 0;
    } else if (unit === 'ml' || unit === 'мл') {
      totalMl = item.qty; isMl = true; pricePerUnit = item.price;
    } else {
      const isPcsOnly = PCS_ONLY.some(kw => nameLower.includes(kw));
      if (!isPcsOnly) {
        const w = getWeightFromName(item.name) || getWeightFromName(mappedName);
        if (w) {
          totalMl = w.g * effectiveQty; isMl = w.isMl;
          pricePerUnit = invoiceTotal > 0 && totalMl > 0 ? invoiceTotal / totalMl : 0;
        } else if (productType === 'alcohol_portion' || productType === 'alcohol_ml') {
          totalMl = DEFAULT_BOTTLE_ML * effectiveQty; isMl = true;
          pricePerUnit = invoiceTotal > 0 ? invoiceTotal / totalMl : 0;
        }
      }
    }

    const fi = { ...base,
      qty: packSize > 1 ? effectiveQty : item.qty,
      price: packSize > 1 ? Number(unitPrice.toFixed(4)) : (item.price || 0),
      packSize: packSize > 1 ? packSize : undefined
    };

    if (productType === 'alcohol_portion') {
      const rule = matchKeys(texts, R.alcohol_portions);
      const vol = totalMl > 0 ? totalMl : DEFAULT_BOTTLE_ML * effectiveQty;
      const ppU = invoiceTotal > 0 ? invoiceTotal / vol : 0;
      const portions = vol / rule.ml;
      result = { ...fi, qty: Number(portions.toFixed(2)), unit: 'portion',
        grams: Math.round(vol),
        price: invoiceTotal > 0 ? Number((invoiceTotal/portions).toFixed(4)) : 0,
        price_per_g: Number(ppU.toFixed(6)) };

    } else if (productType === 'alcohol_ml' && totalMl > 0) {
      result = { ...fi, qty: Math.round(totalMl), unit: 'ml', grams: Math.round(totalMl),
        price: Number(pricePerUnit.toFixed(6)), price_per_g: Number(pricePerUnit.toFixed(6)) };

    } else if (productType === 'food_portion' && totalMl > 0) {
      const rule = matchKeys(texts, R.food_portions);
      const portions = totalMl / rule.g;
      result = { ...fi, qty: Number(portions.toFixed(2)), unit: 'portion',
        grams: Math.round(totalMl),
        price: invoiceTotal > 0 ? Number((invoiceTotal/portions).toFixed(4)) : 0,
        price_per_g: Number(pricePerUnit.toFixed(6)) };

    } else if (totalMl > 0) {
      result = { ...fi, qty: Math.round(totalMl), unit: isMl ? 'ml' : 'g',
        grams: Math.round(totalMl),
        price: Number(pricePerUnit.toFixed(4)), price_per_g: Number(pricePerUnit.toFixed(6)) };

    } else {
      result = fi;
    }
  }

  // ── Learned override: forces final unit regardless of heuristic above ──
  const override = (unitOverrides || {})[normalize(item.name)] || (unitOverrides || {})[normalize(mappedName)];
  if (override && override.unit && override.unit !== result.unit) {
    if (override.unit === 'pcs') {
      result = { ...base, qty: effectiveQty, unit: 'pcs',
        price: Number(unitPrice.toFixed(4)), price_per_g: 0, grams: undefined,
        packSize: packSize > 1 ? packSize : undefined };
    } else if (override.unit === 'box') {
      result = { ...base, qty: item.qty, unit: 'box',
        price: item.price || 0, price_per_g: 0, grams: undefined, packSize: undefined };
    } else if (override.unit === 'g' || override.unit === 'ml' || override.unit === 'kg' || override.unit === 'l') {
      const w = getWeightFromName(item.name) || getWeightFromName(mappedName);
      if (w) {
        const totalVal = w.g * effectiveQty; // grams or ml
        const isBulk = override.unit === 'kg' || override.unit === 'l';
        const qtyOut = isBulk ? totalVal / 1000 : totalVal;
        const ppu = invoiceTotal > 0 && qtyOut > 0 ? invoiceTotal / qtyOut : 0;
        result = { ...base,
          qty: isBulk ? Number(qtyOut.toFixed(3)) : Math.round(qtyOut),
          unit: override.unit, grams: Math.round(totalVal),
          price: Number(ppu.toFixed(isBulk ? 4 : 6)),
          price_per_g: Number(ppu.toFixed(6)) };
      }
    }
  }

  return withVat(result);
}

module.exports = { convertItem, normalize, findSupplier, VAT_RATE };
