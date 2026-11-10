const REPO = 'Bitto29/projects-website';
const FILE_PATH = 'projects.json';
const GITHUB_API = 'https://api.github.com/repos/' + REPO + '/contents/' + FILE_PATH;
const ALLOWED_ORIGINS = new Set([
  'https://bitto29.github.io',
  'https://projects-website29.vercel.app'
]);

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-store');

  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  if (!ALLOWED_ORIGINS.has(origin)) {
    return res.status(403).json({ error: 'This website is not allowed to request preview repairs.' });
  }
  if (!process.env.GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN is not configured on Vercel.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const requestedUrl = normalizeProjectUrl(body.url);
    const failedImage = String(body.failedImage || '');

    if (!requestedUrl) return res.status(400).json({ error: 'A valid HTTPS project URL is required.' });

    const headers = {
      Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'Bitto29-PreviewRepair'
    };

    const initial = await readProjects(headers);
    const initialIndex = initial.projects.findIndex(p => normalizeProjectUrl(p.u) === requestedUrl);
    if (initialIndex < 0) {
      return res.status(404).json({ error: 'This project is not in the projects list.' });
    }

    const currentImage = String(initial.projects[initialIndex].img || '');
    if (currentImage && currentImage !== failedImage) {
      return res.status(200).json({ ok: true, image: currentImage, changed: false });
    }

    const ip = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown').split(',')[0].trim();
    if (!allowRepair(ip, requestedUrl)) {
      return res.status(429).json({ error: 'Preview repair is temporarily limited. Please try again later.' });
    }

    const newImage = await createScreenshot(initial.projects[initialIndex].u);
    if (!newImage) {
      return res.status(502).json({ error: 'The screenshot service could not create a new preview for this project.' });
    }

    // Re-read before saving so a simultaneous repair or project edit is not overwritten.
    for (let attempt = 0; attempt < 2; attempt++) {
      const latest = await readProjects(headers);
      const index = latest.projects.findIndex(p => normalizeProjectUrl(p.u) === requestedUrl);
      if (index < 0) return res.status(404).json({ error: 'This project was removed from the projects list.' });

      const latestImage = String(latest.projects[index].img || '');
      if (latestImage && latestImage !== failedImage) {
        return res.status(200).json({ ok: true, image: latestImage, changed: false });
      }

      latest.projects[index] = { ...latest.projects[index], img: newImage };
      const update = await fetch(GITHUB_API, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          message: 'Repair project preview: ' + String(latest.projects[index].t || 'project').slice(0, 60),
          content: Buffer.from(JSON.stringify(latest.projects, null, 2) + '\n').toString('base64'),
          sha: latest.sha,
          branch: 'main'
        })
      });

      if (update.ok) {
        return res.status(200).json({ ok: true, image: newImage, changed: true });
      }

      const detail = await update.text();
      if (attempt === 0 && (update.status === 409 || update.status === 422)) continue;
      throw new Error('GitHub could not save the new preview: ' + detail.slice(0, 220));
    }

    return res.status(409).json({ error: 'The project list changed while repairing this preview. Please refresh and try again.' });
  } catch (error) {
    console.error('Preview repair failed:', error);
    return res.status(500).json({ error: error.message || 'Preview repair failed.' });
  }
}

async function readProjects(headers) {
  const response = await fetch(GITHUB_API, { headers });
  if (!response.ok) {
    throw new Error('Could not read projects.json from GitHub (' + response.status + ').');
  }
  const file = await response.json();
  return {
    sha: file.sha,
    projects: JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'))
  };
}

function normalizeProjectUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:') return '';
    if (url.username || url.password) return '';
    if (url.hostname === 'localhost' || url.hostname.endsWith('.local')) return '';
    const path = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
    return url.origin + path + url.search;
  } catch {
    return '';
  }
}

async function createScreenshot(projectUrl) {
  try {
    const endpoint = new URL('https://api.microlink.io/');
    endpoint.searchParams.set('url', projectUrl);
    endpoint.searchParams.set('screenshot', 'true');
    endpoint.searchParams.set('meta', 'false');
    endpoint.searchParams.set('viewport.width', '1440');
    endpoint.searchParams.set('viewport.height', '900');
    endpoint.searchParams.set('viewport.deviceScaleFactor', '1');

    const response = await fetch(endpoint.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Bitto29-PreviewRepair/1.0)' },
      signal: AbortSignal.timeout(45000)
    });

    if (response.ok) {
      const data = await response.json();
      const screenshot = data?.data?.screenshot?.url;
      if (isHttpsUrl(screenshot)) return screenshot;
    }
  } catch (error) {
    console.warn('Microlink screenshot failed:', error.message);
  }

  // If the screenshot service is unavailable, try the project's own Open Graph image.
  try {
    const page = await fetch(projectUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Bitto29-PreviewRepair/1.0)' },
      signal: AbortSignal.timeout(20000)
    });
    if (page.ok) {
      const html = await page.text();
      const image = getMeta(html, 'og:image');
      if (isHttpsUrl(image)) return image;
    }
  } catch (error) {
    console.warn('Open Graph image fallback failed:', error.message);
  }
  return '';
}

function isHttpsUrl(value) {
  try { return new URL(String(value || '')).protocol === 'https:'; }
  catch { return false; }
}

function getMeta(html, name) {
  const tags = html.match(/<meta\\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const key = tag.match(/\\b(?:property|name)\\s*=\\s*["']([^"']+)["']/i);
    if (!key || key[1].toLowerCase() !== name.toLowerCase()) continue;
    const value = tag.match(/\\bcontent\\s*=\\s*["']([^"']*)["']/i);
    if (value) return value[1].replace(/&amp;/g, '&').trim();
  }
  return '';
}

// Small per-instance guard against repeated requests from one visitor.
const repairHits = new Map();
function allowRepair(ip, url) {
  const key = ip + '|' + url;
  const now = Date.now();
  const previous = repairHits.get(key);
  if (previous && now - previous.started < 10 * 60 * 1000 && previous.count >= 2) return false;
  if (!previous || now - previous.started >= 10 * 60 * 1000) {
    repairHits.set(key, { started: now, count: 1 });
  } else {
    previous.count++;
  }
  if (repairHits.size > 300) {
    for (const [entry, value] of repairHits) {
      if (now - value.started > 10 * 60 * 1000) repairHits.delete(entry);
    }
  }
  return true;
}
