export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { project, secret } = req.body || {};
    if (!project || typeof project !== 'object') {
      return res.status(400).json({ error: 'Project data is required.' });
    }
    if (!process.env.PUBLISH_SECRET || secret !== process.env.PUBLISH_SECRET) {
      return res.status(401).json({ error: 'Invalid publish secret.' });
    }
    if (!process.env.GITHUB_TOKEN) {
      return res.status(500).json({ error: 'GITHUB_TOKEN is not configured on Vercel.' });
    }

    const repo = 'Bitto29/projects-website';
    const path = 'projects.json';
    const api = 'https://api.github.com/repos/' + repo + '/contents/' + path;

    const headers = {
      Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'Bitto29-ProjectsPublisher'
    };

    const current = await fetch(api, { headers });
    if (!current.ok) throw new Error('Could not read projects.json from GitHub.');
    const file = await current.json();

    const decoded = Buffer.from(file.content, 'base64').toString('utf8');
    const projects = JSON.parse(decoded);
    const projectUrl = String(project.u || '').trim();
    const duplicateIndex = projects.findIndex(p => String(p.u || '').trim().toLowerCase() === projectUrl.toLowerCase());
    if (duplicateIndex !== -1) {
      return res.status(409).json({ error: 'This project is already in your projects list.' });
    }

    const maxOrder = projects.reduce((max, p) => Math.max(max, Number(p.order) || 0), 0);

    const next = {
      t: String(project.t || 'Untitled Project'),
      c: String(project.c || 'Web App'),
      d: String(project.d || ''),
      img: String(project.img || ''),
      u: String(project.u || ''),
      l: String(project.l || 'View Project'),
      tags: Array.isArray(project.tags) ? project.tags.map(String).slice(0, 20) : [],
      tech: Array.isArray(project.tech) ? project.tech.map(String).slice(0, 12) : [],
      order: maxOrder + 1
    };

    projects.unshift(next);

    const content = Buffer.from(JSON.stringify(projects, null, 2) + '\n').toString('base64');
    const update = await fetch(api, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: 'Add project: ' + next.t,
        content,
        sha: file.sha,
        branch: 'main'
      })
    });

    if (!update.ok) {
      const detail = await update.text();
      throw new Error('GitHub update failed: ' + detail.slice(0, 300));
    }

    return res.status(200).json({ ok: true, project: next });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Publish failed.' });
  }
}
