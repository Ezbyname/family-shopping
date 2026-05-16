// js/translation/aiResolver.js
// Layer 3: AI fallback — called ONLY when dictionary + fuzzy both fail
// Returns strict JSON suggestions, low token usage

const AI_PROMPT = (term) => `You are a supermarket product resolver.
The user is searching for a grocery product in Hebrew: "${term}"
Return ONLY a JSON object. No explanation. No markdown. No extra text.
Format:
{"suggestions":["english product 1","english product 2","english product 3"]}
Rules:
- max 5 suggestions
- use short supermarket-style English names
- think: what products in a supermarket match this Hebrew term?
- if completely unknown, suggest closest grocery items
- temperature: 0 (deterministic)`;

export async function getAISuggestions(hebrewTerm) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 150,
        messages: [{ role: 'user', content: AI_PROMPT(hebrewTerm) }],
      }),
    });

    if (!response.ok) throw new Error('AI API error: ' + response.status);

    const data = await response.json();
    const text = data?.content?.[0]?.text || '';

    // Safe JSON parse — strip any accidental markdown
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    if (!Array.isArray(parsed?.suggestions)) throw new Error('Invalid AI response format');

    return {
      success: true,
      suggestions: parsed.suggestions.slice(0, 5).map(s => s.toLowerCase().trim()),
      source: 'ai',
    };
  } catch (err) {
    console.error('AI resolver error:', err);
    return { success: false, suggestions: [], source: 'ai', error: err.message };
  }
}