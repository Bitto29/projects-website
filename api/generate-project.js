export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { url } = req.body || {};
    if (!url || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'Please provide a valid project URL.' });
    }

    const target = new URL(url);
    const response = await fetch(target.href, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Bitto29-ProjectsBot/1.0)' }
    });

    if (!response.ok) {
      return res.status(400).json({ error: `Could not open project: HTTP ${response.status}` });
    }

    const html = await response.text();

    let screenshotUrl = '';
    try {
      const shotUrl = 'https://api.microlink.io/?url=' + encodeURIComponent(target.href) +
        '&screenshot=true&meta=false&viewport.width=1440&viewport.height=900&viewport.deviceScaleFactor=1&embed=screenshot.url';
      const shot = await fetch(shotUrl.replace('&embed=screenshot.url', ''));
      if (shot.ok) {
        const shotData = await shot.json();
        screenshotUrl = shotData?.data?.screenshot?.url || '';
      }
    } catch {}
    const title = getMeta(html, 'og:title') || getTitle(html) || target.hostname;
    const description = getMeta(html, 'og:description') || getMeta(html, 'description') || '';
    const image = getMeta(html, 'og:image') || '';

    const textContent = html
      .replace(/<script[\\s\\S]*?<\\/script>/gi, ' ')
      .replace(/<style[\\s\\S]*?<\\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim()
      .slice(0, 7000);

    let generated = {
      t: clean(title).slice(0, 80) || 'Untitled Project',
      c: guessCategory(title, description, textContent),
      d: clean(description).slice(0, 220) || 'A web project created by Basit Iqbal Bitto.',
      tags: [],
      tech: []
    };

    if (process.env.GEMINI_API_KEY) {
      const prompt = `Analyze this web project and return ONLY valid JSON with keys t,c,d,tags,tech.
t = concise project title.
c = one category such as Web App, Website, AI, Tool, Game, Portfolio, Interactive, Security, Other.
d = natural 1-2 sentence description, max 220 characters.
tags = 3-6 short relevant tags.
tech = technologies/frameworks you can reasonably infer from the supplied page text, max 8.
Do not invent specific technologies unless there is evidence.

URL: ${target.href}
Page title: ${title}
Meta description: ${description}
Page text: ${textContent}`;

      const ai = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' +
        encodeURIComponent(process.env.GEMINI_API_KEY),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json' }
          })
        }
      );

      if (ai.ok) {
        const data = await ai.json();
        const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        try {
          const parsed = JSON.parse(raw);
          generated = {
            ...generated,
            ...parsed,
            tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 6) : generated.tags,
            tech: Array.isArray(parsed.tech) ? parsed.tech.slice(0, 8) : generated.tech
          };
        } catch {}
      }
    }

    return res.status(200).json({
      project: {
        ...generated,
        u: target.href,
        img: screenshotUrl || image,
        l: 'View Project',
        order: Date.now()
      },
      source: { title, description, image }
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Generation failed.' });
  }
}

function getMeta(html, name) {
  const tags = html.match(/<meta\\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const key = tag.match(/\\b(?:property|name)\\s*=\\s*["']([^"']+)["']/i);
    if (!key || key[1].toLowerCase() !== name.toLowerCase()) continue;
    const value = tag.match(/\\bcontent\\s*=\\s*["']([^"']*)["']/i);
    if (value) return clean(value[1]);
  }
  return '';
}

function getTitle(html) {
  return clean((html.match(/<title[^>]*>([\\s\\S]*?)<\\/title>/i) || [,''])[1]);
}

function clean(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\s+/g, ' ')
    .trim();
}

function guessCategory(title, description, text) {
  const s = (title + ' ' + description + ' ' + text).toLowerCase();
  if (/chatgpt|ai|artificial intelligence|gemini|llm|chatbot/.test(s)) return 'AI';
  if (/portfolio|resume|curriculum vitae|cv/.test(s)) return 'Portfolio';
  if (/game|quiz|puzzle|rock paper|tic tac/.test(s)) return 'Game';
  if (/generator|calculator|converter|qr code|password/.test(s)) return 'Tool';
  if (/cafe|restaurant|business|agency/.test(s)) return 'Website';
  return 'Web App';
}
