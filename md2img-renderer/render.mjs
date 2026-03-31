import fs from 'fs-extra';
import path from 'path';
import { glob } from 'glob';
import puppeteer from 'puppeteer';
import { marked } from 'marked';
import hljs from 'highlight.js';

const RENDERER_DIR = process.cwd();
const PARENT_DIR = path.resolve(RENDERER_DIR, '..');
const OUTPUT_DIR = path.resolve(PARENT_DIR, '_export_images');

// Configure marked with highlight.js and custom mermaid wrapper
const renderer = new marked.Renderer();
const originalCode = renderer.code.bind(renderer);
renderer.code = (code, language) => {
  if (language === 'mermaid') {
    return `<div class="mermaid">${code}</div>`;
  }
  return originalCode(code, language);
};

marked.setOptions({
  renderer,
  highlight: function(code, lang) {
    if (lang && hljs.getLanguage(lang) && lang !== 'mermaid') {
      try {
        return hljs.highlight(code, { language: lang }).value;
      } catch (__) {}
    }
    return code; // default escape
  }
});

const getHtml = (content, title) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.5.1/github-markdown.min.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">
  <style>
    /* 1080x1440 layout - retina quality styling */
    html, body {
      margin: 0;
      padding: 0;
      height: 1440px;
      /* background must be explicitly set for screenshot */
      background: #ffffff !important; 
    }
    
    .markdown-body {
      box-sizing: border-box;
      height: 1440px;
      padding: 80px 80px 100px 80px; 
      /* Title and Content Space */
      font-size: 26px; /* Scales well with 1080 width */
      
      /* Multi-column layout handles automatic pagination natively */
      column-width: 920px; 
      column-gap: 160px;
      column-fill: auto;
    }
    
    .markdown-body pre, 
    .markdown-body img, 
    .markdown-body table, 
    .markdown-body .mermaid, 
    .markdown-body h1, 
    .markdown-body h2, 
    .markdown-body h3, 
    .markdown-body h4 {
      break-inside: avoid;
      page-break-inside: avoid;
      margin-bottom: 24px;
    }

    .markdown-body p {
      margin-bottom: 24px;
      line-height: 1.6;
    }
    
    .markdown-body img {
      max-width: 100%;
      border-radius: 12px;
      box-shadow: 0 4px 14px rgba(0,0,0,0.08);
    }
    
    .markdown-body pre {
      font-size: 20px; /* Monospace adjustment */
    }

    /* Beautiful subtle page watermark / footer wrapper could be added here */
  </style>
</head>
<body>
  <article class="markdown-body">
    <h1>${title}</h1>
    ${content}
  </article>
  
  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
    mermaid.initialize({ startOnLoad: false, theme: 'default' });
    window.renderMermaid = async () => {
      try {
        if (document.querySelectorAll('.mermaid').length > 0) {
          await mermaid.run({
            querySelector: '.mermaid'
          });
        }
      } catch (e) {
        console.error(e);
      }
      window.mermaidDone = true;
    };
    window.renderMermaid();
  </script>
</body>
</html>
`;

async function main() {
  console.log(`Searching for markdown files in ${PARENT_DIR} ...`);
  
  // Find all .md files, ignoring node_modules and md2img-renderer itself
  const files = await glob('**/*.md', {
    cwd: PARENT_DIR,
    ignore: ['**/node_modules/**', 'md2img-renderer/**', '_export_images/**', '.*/**']
  });

  if (files.length === 0) {
    console.log('No Markdown files found.');
    return;
  }
  console.log(`Found ${files.length} markdown note(s).`);

  // Ensure output directory
  await fs.ensureDir(OUTPUT_DIR);

  const browser = await puppeteer.launch({ 
    headless: 'new',
    // Make sure we have enough resolution for high-quality Xiaohongshu text
    defaultViewport: { width: 1080, height: 1440, deviceScaleFactor: 2 }
  });

  for (const file of files) {
    const filePath = path.join(PARENT_DIR, file);
    const content = await fs.readFile(filePath, 'utf-8');
    const title = path.basename(file, '.md');
    
    console.log(`\nRendering: ${file}`);
    const parsedHtml = marked.parse(content);
    const fullHtml = getHtml(parsedHtml, title);

    const page = await browser.newPage();
    
    // Load local HTML directly
    await page.setContent(fullHtml, { waitUntil: 'networkidle0' });
    
    // Wait for fonts to load
    await page.evaluateHandle('document.fonts.ready');
    
    // Wait for Mermaid
    await page.waitForFunction('window.mermaidDone === true', { timeout: 30000 }).catch(e => console.log('Mermaid timeout or none present'));

    // Emulate screen to trigger normal CSS 
    await page.emulateMediaType('screen');

    // Get the total horizontal width of the content resulting from css column-width wrapping
    const totalWidth = await page.evaluate(() => {
      return document.querySelector('.markdown-body').scrollWidth;
    });
    
    // If empty or small, fallback to 1 page
    const viewWidth = 1080;
    const scrollWidth = Math.max(totalWidth, viewWidth); 
    const numPages = Math.ceil(scrollWidth / viewWidth);
    
    console.log(`Detected ${numPages} page(s) based on scrollWidth ${scrollWidth}px.`);

    // Create a specific folder for each note based on its structure
    // Example format: _export_images/06-服务与基础/04-utils-model-auth/page-0.png
    const pageOutDir = path.join(OUTPUT_DIR, file.replace(/\.md$/, ''));
    await fs.ensureDir(pageOutDir);

    for (let i = 0; i < numPages; i++) {
        const outPath = path.join(pageOutDir, `page-${i}.png`);
        
        // Use rect clip to screenshot specific columns accurately
        await page.screenshot({
            path: outPath,
            clip: {
                x: i * viewWidth,
                y: 0,
                width: viewWidth,
                height: 1440
            }
        });
        console.log(` -> Created ${outPath}`);
    }

    await page.close();
  }

  await browser.close();
  console.log('\nAll notes have been successfully rendered into aesthetic imagery!');
}

main().catch(console.error);
