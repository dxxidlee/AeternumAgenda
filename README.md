# Aeternum Agenda — Living Archive

The Living Archive for Core 4: Thesis. Research, references, experiments, failures, questions, conversations and observations, kept week by week.

The public site (Vercel) is read-only. You edit locally, then publish.

## How it is organised

Every entry sits on three axes, and the index can be switched between them:

- **Weeks**: when it entered the process. The numbers down the left edge are the weeks of the thesis year. Each week can have a title, a summary, open questions and next steps.
- **Threads**: lines of inquiry (Preclinical, Regulatory and Legal, …). The original image sections live here.
- **Kinds**: what role it played: Research, Reference, Inspiration, Observation, Question, Conversation, Note, Experiment, Failure, Prototype, Presentation.

Entries can be images, PDFs, Figma files (embedded live), websites, YouTube/Vimeo or video files, audio, or written notes. A PDF can also carry a live Figma link.

## Weekly routine

```bash
node tools/edit.mjs
```

This opens http://localhost:4321 in editing mode. The current week is created automatically.

1. **Add** (or press A): paste links, upload files, or write a note. Links get their real title and preview image. Files are copied into `files/week-NN/`.
2. Open the week and click **Edit week** to write the summary, open questions and next steps.
3. Click **Publish**. This commits `archive-manifest.json` and `files/`, pushes to GitHub, and Vercel redeploys.

Changes save to disk as you type. Recent versions of the manifest are kept in `.archive-backups/`, which git ignores.

## Notes

- Everything you publish is public, including notes and week summaries. Keep private reflections out of the archive.
- GitHub rejects files over 100 MB. Compress large book PDFs first; the editor warns you. Full-resolution originals can live in `originals/`, which is never committed or deployed.
- Uploaded PDFs and videos get a preview image in `files/week-NN/posters/` automatically. For a website, paste a screenshot path into "Preview image URL".
- Live Figma embeds only show for visitors if the Figma file is shared as "Anyone with the link can view".
- Each week, thread and entry has its own link (e.g. `/#/weeks/05`, `/#/entry/abc1234`), which is handy for crits.
- The week numbering starts from the date set in Info → Settings → "First day of Week 01".
