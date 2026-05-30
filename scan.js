// Vercel serverless function - 60 second timeout
// Strategy: Pre-fetch RSS headlines first (fast), then send to Claude with web search for depth

const NEWS_FEEDS = [
  "https://feeds.a.dj.com/rss/RSSMarketsMain.xml",          // WSJ Markets
  "https://feeds.reuters.com/reuters/businessNews",           // Reuters Business  
  "https://www.cnbc.com/id/100003114/device/rss/rss.html",  // CNBC Markets
  "https://feeds.content.dowjones.io/public/rss/mw_topstories", // MarketWatch
];

async function fetchRSSHeadlines(people) {
  const headlines = [];
  const personLower = people.map(p => p.toLowerCase().split(' '));

  await Promise.allSettled(
    NEWS_FEEDS.map(async (url) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
        const text = await res.text();
        // Extract titles and descriptions from RSS
        const items = text.match(/<item>[\s\S]*?<\/item>/g) || [];
        for (const item of items.slice(0, 15)) {
          const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/))?.[1] || '';
          const desc  = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || item.match(/<description>(.*?)<\/description>/))?.[1] || '';
          const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
          const combined = (title + ' ' + desc).toLowerCase();
          // Only include if relevant to tracked people or market-moving
          const relevant = personLower.some(parts => parts.every(part => combined.includes(part)))
            || combined.match(/tariff|sanction|executive order|fed rate|earnings|merger|acquisition|ban|deal|billion/);
          if (relevant && title) {
            headlines.push(`[${pubDate}] ${title}: ${desc.slice(0, 150).replace(/<[^>]+>/g, '')}`);
          }
        }
      } catch {}
    })
  );

  return headlines.slice(0, 20);
}

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const { people = ['Donald Trump'], wordWatches = [] } = req.body || {};
  const peopleList = people.join(', ');
  const today = new Date().toISOString().split('T')[0];

  // Step 1: Pre-fetch RSS headlines in parallel (fast - 4s max)
  let rssContext = '';
  try {
    const headlines = await fetchRSSHeadlines(people);
    if (headlines.length > 0) {
      rssContext = `\n\nHere are recent news headlines to help inform your analysis:\n${headlines.join('\n')}\n`;
    }
  } catch {}

  const wordWatchSection = wordWatches.length > 0
    ? `\n\nAlso check for these specific keywords and include wordMatches entries if found:\n${wordWatches.map(w => `- "${w.word}" said by ${w.person}`).join('\n')}`
    : '';

  const prompt = `You are a financial intelligence analyst. Today is ${today}.

Search for the most recent market-moving public statements made by: ${peopleList}.

Search across: Truth Social, X/Twitter, press conferences, TV interviews, rally speeches, executive orders, and news coverage.${rssContext}

Return ONLY raw JSON — no markdown, no explanation, no code fences. Your entire response must start with { and end with }:

{
  "mentions": [
    {
      "person": "Full name of who said it",
      "ticker": "STOCK_TICKER",
      "company": "Full Company Name",
      "context": "Exact quote or close paraphrase of what was said",
      "sentiment": "BULLISH or BEARISH or NEUTRAL",
      "source": "Where it was said e.g. Truth Social, Press Conference, Fox News",
      "mentionedAt": "${today}T10:00:00.000Z",
      "priceAtMention": 150.00,
      "currentPrice": 155.00,
      "changePercent": 3.2,
      "volume": "estimated volume e.g. 145% above avg",
      "sector": "Stock sector",
      "signal": "1-2 sentence trading signal based on the statement",
      "keyLevels": { "support": 145, "resistance": 165 },
      "urgency": "HIGH or MEDIUM or LOW"
    }
  ],
  "wordMatches": [
    {
      "person": "Who said it",
      "word": "the keyword",
      "quote": "exact quote containing the word",
      "source": "where it was said",
      "timestamp": "${today}T10:00:00.000Z",
      "confidence": "HIGH or MEDIUM or LOW"
    }
  ]
}${wordWatchSection}

Use web search to find the most recent real statements. Return 4-6 mention entries with realistic current stock prices. Focus on statements most likely to move markets.`;

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2500,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await anthropicRes.json();

    // Extract text from all content block types
    let allText = '';
    for (const block of (data.content || [])) {
      if (block.type === 'text') allText += ' ' + block.text;
      if (block.type === 'tool_result') {
        for (const inner of (block.content || [])) {
          if (inner.type === 'text') allText += ' ' + inner.text;
        }
      }
    }

    // Find JSON by locating "mentions" key anchor
    let parsed = null;
    const mentionsIdx = allText.indexOf('"mentions"');
    if (mentionsIdx > -1) {
      const start = allText.lastIndexOf('{', mentionsIdx);
      if (start > -1) {
        let depth = 0, end = start;
        for (let i = start; i < allText.length; i++) {
          if (allText[i] === '{') depth++;
          else if (allText[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        try {
          parsed = JSON.parse(allText.slice(start, end + 1));
        } catch {
          try {
            const cleaned = allText.slice(start, end + 1)
              .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
              .replace(/,\s*([}\]])/g, '$1'); // trailing commas
            parsed = JSON.parse(cleaned);
          } catch {}
        }
      }
    }

    if (!parsed) {
      return res.status(500).json({
        error: 'Could not parse AI response. Please try again.',
        debug: allText.slice(0, 400),
      });
    }

    return res.status(200).json({
      success: true,
      data: parsed,
      scannedAt: new Date().toISOString(),
      rssHeadlinesUsed: rssContext.length > 0,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
