export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const { people = ['Donald Trump'], wordWatches = [] } = req.body || {};
  const peopleList = people.join(', ');
  const today = new Date().toISOString().split('T')[0];

  const wordSection = wordWatches.length > 0
    ? `\n\nCheck for these keywords and add to wordMatches if found:\n${wordWatches.map(w => `- "${w.word}" by ${w.person}`).join('\n')}`
    : '';

  const prompt = `You are a financial analyst. Today is ${today}. Search for recent market-moving statements by: ${peopleList}.

Search Truth Social, X/Twitter, press conferences, TV interviews, news.${wordSection}

YOU MUST respond with ONLY a JSON object. No text before or after. No markdown. No explanation. Just JSON.

{"mentions":[{"person":"name","ticker":"TICKER","company":"Company","context":"quote","sentiment":"BULLISH","source":"Truth Social","mentionedAt":"${today}T10:00:00.000Z","priceAtMention":150.00,"currentPrice":155.00,"changePercent":3.2,"volume":"120% above avg","sector":"sector","signal":"signal text","keyLevels":{"support":145,"resistance":165},"urgency":"HIGH"}],"wordMatches":[]}

Return 4-6 real mentions. Stock prices will be updated with real-time data after you respond, so just use approximate prices.`;

  try {
    // Step 1: Get AI mentions
    const response = await fetch('https://api.anthropic.com/v1/messages', {
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

    const data = await response.json();

    let allText = '';
    for (const block of (data.content || [])) {
      if (block.type === 'text') allText += block.text;
    }

    // Strip markdown
    let searchText = allText.replace(/```json/g, '').replace(/```/g, '');

    // Find JSON
    let parsed = null;
    const start = searchText.indexOf('{"mentions"');
    if (start !== -1) {
      let depth = 0, end = start;
      for (let i = start; i < searchText.length; i++) {
        if (searchText[i] === '{') depth++;
        else if (searchText[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      try { parsed = JSON.parse(searchText.slice(start, end + 1)); } catch(e) {
        try {
          const fixed = searchText.slice(start, end + 1).replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
          parsed = JSON.parse(fixed);
        } catch(e2) {}
      }
    }

    if (!parsed) {
      const idx = searchText.indexOf('"mentions"');
      if (idx > -1) {
        const s = searchText.lastIndexOf('{', idx);
        if (s > -1) {
          let depth = 0, end = s;
          for (let i = s; i < searchText.length; i++) {
            if (searchText[i] === '{') depth++;
            else if (searchText[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
          }
          try { parsed = JSON.parse(searchText.slice(s, end + 1)); } catch(e) {}
        }
      }
    }

    if (!parsed) {
      return res.status(500).json({ error: 'Could not parse response', debug: allText.slice(0, 500) });
    }

    // Step 2: Fetch real-time prices from Yahoo Finance
    const mentions = parsed.mentions || [];
    const tickers = [...new Set(mentions.map(m => m.ticker).filter(Boolean))];

    if (tickers.length > 0) {
      const priceMap = {};
      await Promise.allSettled(
        tickers.map(async (ticker) => {
          try {
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=2d`;
            const r = await fetch(url, {
              headers: { 'User-Agent': 'Mozilla/5.0' },
              signal: AbortSignal.timeout(5000),
            });
            const json = await r.json();
            const result = json?.chart?.result?.[0];
            if (result) {
              const meta = result.meta;
              const currentPrice = meta.regularMarketPrice || meta.previousClose;
              const prevClose = meta.previousClose || meta.chartPreviousClose;
              const changePercent = prevClose ? ((currentPrice - prevClose) / prevClose * 100) : 0;
              priceMap[ticker] = {
                currentPrice: parseFloat(currentPrice?.toFixed(2)),
                priceAtMention: parseFloat(prevClose?.toFixed(2)),
                changePercent: parseFloat(changePercent.toFixed(2)),
              };
            }
          } catch {}
        })
      );

      // Update mentions with real prices
      parsed.mentions = mentions.map(m => {
        if (priceMap[m.ticker]) {
          return { ...m, ...priceMap[m.ticker] };
        }
        return m;
      });
    }

    return res.status(200).json({
      success: true,
      data: parsed,
      scannedAt: new Date().toISOString(),
      realPrices: true,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
