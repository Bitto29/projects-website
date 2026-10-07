export default async function handler(req, res) {
  const secret = req.headers['x-publish-secret'] || req.body?.secret;
  if (!process.env.PUBLISH_SECRET || secret !== process.env.PUBLISH_SECRET) {
    return res.status(401).json({ error: 'Invalid publish secret.' });
  }
  if (!process.env.GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN is not configured.' });
  }

  const repo = 'Bitto29/projects-website';
  const path = 'projects.json';
  const api = 'https://api.github.com/repos/' + repo + '/contents/' + path;
  const headers = {
    Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'Bitto29-ProjectsManager'
  };

  try {
    const current = await fetch(api, { headers });
    if (!current.ok) throw new Error('Could not read projects.json from GitHub.');
    const file = await current.json();
    const projects = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));

    if (req.method === 'GET') {
      return res.status(200).json({ projects });
    }

    if (req.method !== 'PUT') return res.status(405).json({ error: 'Method not allowed.' });

    const incoming = req.body?.projects;
    if (!Array.isArray(incoming)) return res.status(400).json({ error: 'Projects array is required.' });

    const cleaned = incoming.map((p, i) => ({
      t: String(p.t || 'Untitled Project').trim(),
      c: String(p.c || 'Web App').trim(),
      d: String(p.d || '').trim(),
      img: String(p.img || '').trim(),
      u: String(p.u || '').trim(),
      l: String(p.l || 'View Project').trim(),
      ...(Array.isArray(p.tags) ? { tags: p.tags.map(String).slice(0, 20) } : {}),
      ...(Array.isArray(p.tech) ? { tech: p.tech.map(String).slice(0, 12) } : {}),
      order: incoming.length - i
    })).filter(p => p.u);

    const content = Buffer.from(JSON.stringify(cleaned, null, 2) + '\n').toString('base64');
    const update = await fetch(api, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: 'Manage projects: reorder or delete projects',
        content,
        sha: file.sha,
        branch: 'main'
      })
    });

    if (!update.ok) throw new Error('GitHub update failed: ' + (await update.text()).slice(0, 300));
    return res.status(200).json({ ok: true, projects: cleaned });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Project management failed.' });
  }
}