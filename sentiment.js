// sentiment.js — Detects positive vs negative/neutral healing replies
// Designed for Hebrew + English text from clients

// Strong positive words/phrases (Hebrew + English)
const POSITIVE = [
  // Hebrew
  'מעולה', 'נהדר', 'יפה', 'מדהים', 'מושלם', 'אדיר', 'סבבה',
  'טוב', 'בסדר', 'הכל טוב', 'הולך טוב', 'הולך מצוין', 'הכל מצוין',
  'מרוצה', 'מאושר', 'מאושרת', 'אוהב', 'אוהבת',
  'תודה', 'תודה רבה',
  // English
  'great', 'amazing', 'perfect', 'beautiful', 'awesome', 'love it',
  'good', 'fine', 'all good', 'going well', 'healing well', 'no issues',
  'happy', 'thanks', 'thank you',
];

// Concerning words — should NOT trigger review request, alert artist
const NEGATIVE = [
  // Hebrew — concerns
  'אדום', 'אדמומיות', 'מוגלה', 'דלקת', 'נפוח', 'נפיחות',
  'כואב', 'כאב', 'גרד', 'מגרד', 'מדמם', 'דם',
  'דואג', 'דואגת', 'מודאג', 'מודאגת', 'בעיה',
  'לא טוב', 'לא בסדר', 'גרוע', 'נורא',
  // English — concerns
  'red', 'redness', 'pus', 'infected', 'infection', 'swollen', 'swelling',
  'hurts', 'painful', 'itchy', 'bleeding', 'bleed',
  'worried', 'worry', 'concern', 'concerned', 'problem', 'issue',
  'not good', 'bad', 'terrible', 'awful',
];

function normalize(text) {
  return text.toLowerCase().trim();
}

function containsAny(text, list) {
  const t = normalize(text);
  return list.some(word => t.includes(word.toLowerCase()));
}

// Returns: 'positive' | 'negative' | 'neutral'
function analyze(text) {
  if (!text || text.trim().length === 0) return 'neutral';
  const t = normalize(text);

  // Negation phrases — if any of these appear, treat as positive even if a
  // negative keyword is present (e.g. "no redness", "אין בעיה")
  const negationPhrases = [
    'no issues', 'no problem', 'no concerns', 'no pain', 'no redness',
    'not bad', 'not painful', 'not red', 'all good',
    'אין בעיה', 'אין בעיות', 'אין כאב', 'אין אדמומיות', 'ללא בעיה',
  ];
  const hasNegation = negationPhrases.some(p => t.includes(p));
  if (hasNegation) return 'positive';

  const hasNegative = containsAny(text, NEGATIVE);
  const hasPositive = containsAny(text, POSITIVE);

  // Negative words win — safety first
  if (hasNegative) return 'negative';
  if (hasPositive) return 'positive';
  return 'neutral';
}

module.exports = { analyze };
