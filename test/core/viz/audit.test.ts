import { describe, expect, test } from "bun:test";
import { auditHtml, HTML_ELEMENTS, SVG_ELEMENTS, type Audit } from "../../../core/viz/audit";
import { cspFor, page } from "../../../core/viz/page";

const doc = (head: string, body: string): string => `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;
const csp = (style: string, script: string): string => `<meta http-equiv="Content-Security-Policy" content="${cspFor(style, script)}">`;
/** Clean as later tasks define it (pre-flight F10): CSP pinned and canonical, nothing external, no style attributes or handlers. */
const clean = (a: Audit): boolean =>
  a.cspOk && a.nonCanonical.length === 0 && a.externalRefs.length === 0 && a.styleAttrs === 0 && a.inlineHandlers === 0;
const PAGE = { title: "Your practice", footerLeft: "Jordan Example · No. 7F3A-91C2", fonts: "none" } as const;
/** A clean page with `inner` inside its main. */
const inPage = (inner: string): string => page({ ...PAGE, body: `<main id="main"><p>before</p>${inner}<p>after</p></main>` });
const codes = (a: Audit): string[] => a.nonCanonical.map((f) => f.replace(/ at \d+$/, ""));

describe("auditHtml: the brief's crafted document", () => {
  const html = doc(`<meta charset="utf-8"><title>t</title><style>a{background:url(//x)}@import "y";</style><link href="z">`,
    `<img src="https://x"><p style="color:red" onclick="x()">t</p><a href="#ok">ok</a>`);
  const a = auditHtml(html);

  test("it reports each external reference, by kind", () => {
    expect(a.externalRefs).toEqual(expect.arrayContaining(["src=https://x", "url(//x)", "href=z", "<link>"]));
    expect(a.externalRefs.some((r) => r.startsWith("@import"))).toBe(true);
    expect(a.externalRefs.some((r) => r.includes("#ok"))).toBe(false);
  });

  test("it counts style attributes and inline handlers", () => {
    expect([a.styleAttrs, a.inlineHandlers]).toEqual([1, 1]);
  });

  test("no CSP: csp is null and cspOk false", () => {
    expect([a.csp, a.cspOk]).toEqual([null, false]);
  });

  test("bytes are UTF-8 bytes; elements count start tags", () => {
    expect(auditHtml("<!doctype html><p>·</p>").bytes).toBe(24);
    expect(auditHtml("<!doctype html><p>·</p>").elements).toBe(1);
  });
});

describe("auditHtml: elements", () => {
  test("start tags inside script, style and pre are not counted; the elements themselves are", () => {
    const a = auditHtml(doc(`<meta charset="utf-8"><style>a{}</style>`, `<div><pre><b>x</b><i>y</i></pre><script>"a<p>"</script></div>`));
    expect(a.elements).toBe(8);
    expect(a.nonCanonical).toEqual([]);
  });
});

describe("auditHtml: cspOk", () => {
  const S = "a{}";
  const J = "void 0;";

  test("true for a canonical page whose CSP, second in head, pins the one style and the one script", () => {
    expect(auditHtml(doc(`<meta charset="utf-8">${csp(S, J)}<style>${S}</style>`, `<script>${J}</script>`)).cspOk).toBe(true);
  });

  test("a JSON island is not executable, so it does not count", () => {
    const html = doc(`<meta charset="utf-8">${csp(S, J)}<style>${S}</style>`, `<script type="application/json" id="d">{}</script><script>${J}</script>`);
    expect(auditHtml(html).cspOk).toBe(true);
  });

  test("false when the CSP is not the second head element", () => {
    expect(auditHtml(doc(`<meta charset="utf-8"><title>t</title>${csp(S, J)}<style>${S}</style>`, `<script>${J}</script>`)).cspOk).toBe(false);
  });

  test("false with a second style or a second executable script", () => {
    expect(auditHtml(doc(`<meta charset="utf-8">${csp(S, J)}<style>${S}</style><style>${S}</style>`, `<script>${J}</script>`)).cspOk).toBe(false);
    expect(auditHtml(doc(`<meta charset="utf-8">${csp(S, J)}<style>${S}</style>`, `<script>${J}</script><script type="module">${J}</script>`)).cspOk).toBe(false);
  });

  test("false when a hash does not match the text", () => {
    expect(auditHtml(doc(`<meta charset="utf-8">${csp(S, J)}<style>b{}</style>`, `<script>${J}</script>`)).cspOk).toBe(false);
    expect(auditHtml(doc(`<meta charset="utf-8">${csp(S, J)}<style>${S}</style>`, `<script>${J} </script>`)).cspOk).toBe(false);
  });

  test("false when anything is not canonical, even with the hashes right", () => {
    expect(auditHtml(doc(`<meta charset="utf-8">${csp(S, J)}<style>${S}</style>`, `<script>${J}</script><!-- x -->`)).cspOk).toBe(false);
  });

  test("false when the head's first child is not exactly the charset meta, even with the CSP second", () => {
    const head = (first: string): string => doc(`${first}${csp(S, J)}<style>${S}</style>`, `<script>${J}</script>`);
    expect(auditHtml(head('<meta charset="utf-8">')).cspOk).toBe(true);
    for (const first of ['<meta name="referrer" content="no-referrer">', '<meta name="color-scheme" content="dark light">', "<title>t</title>",
      '<meta charset="UTF-8">', '<meta\ncharset="utf-8">']) {
      const a = auditHtml(head(first));
      expect([first, a.cspOk, codes(a).includes("charset")]).toEqual([first, false, true]);
    }
  });

  test("the charset meta must also end within the first 1,024 bytes", () => {
    const html = doc(`<meta charset="utf-8">${csp(S, J)}<style>${S}</style>`, `<script>${J}</script>`).replace('<html lang="en">', `<html lang="${"e".repeat(1100)}">`);
    const a = auditHtml(html);
    expect([a.cspOk, codes(a)]).toEqual([false, ["charset"]]);
  });

  test("csp holds the policy text", () => {
    expect(auditHtml(doc(`<meta charset="utf-8">${csp(S, J)}`, "")).csp).toBe(cspFor(S, J));
  });
});

describe("auditHtml: the canonical subset, rule by rule", () => {
  const cases: [string, string, string][] = [
    ["no doctype", "<p>x</p>", "doctype"],
    ["a comment", "<!doctype html><!-- x -->", "declaration"],
    ["CDATA", "<!doctype html><![CDATA[x]]>", "declaration"],
    ["a processing instruction", "<!doctype html><?x?>", "declaration"],
    ["an unknown element", "<!doctype html><textarea>x</textarea>", "element"],
    ["an upper-case element", "<!doctype html><DIV>x</DIV>", "element"],
    ["an SVG element outside svg", "<!doctype html><path d=\"M0 0\"/>", "element"],
    ["an HTML element inside svg", "<!doctype html><svg><p>x</p></svg>", "element"],
    ["foreignObject", "<!doctype html><svg><foreignObject></foreignObject></svg>", "foreign-object"],
    ["self-closing outside svg", "<!doctype html><div/>", "self-closing"],
    ["an end tag with attributes", "<!doctype html><p>x</p a=\"b\">", "end-tag"],
    ["an unquoted value", "<!doctype html><p class=x>y</p>", "attribute"],
    ["a single-quoted value", "<!doctype html><p class='x'>y</p>", "attribute"],
    ["a valueless attribute", "<!doctype html><details open>y</details>", "attribute"],
    ["a tab separator", "<!doctype html><p\tclass=\"x\">y</p>", "attribute"],
    ["a non-ASCII space in a tag", "<!doctype html><p\u00a0class=\"x\">y</p>", "attribute"],
    ["a duplicate attribute", "<!doctype html><p class=\"a\" CLASS=\"b\">y</p>", "duplicate-attribute"],
    ["two elements with one id", "<!doctype html><p id=\"a\">x</p><p id=\"a\">y</p>", "duplicate-id"],
    ["an HTML id repeated inside svg", "<!doctype html><p id=\"r\">x</p><svg><path id=\"r\" d=\"M0 0\"/></svg>", "duplicate-id"],
    ["a meta that is not allowed", "<!doctype html><meta name=\"generator\" content=\"x\">", "meta"],
    ["a raw < in text", "<!doctype html><p>a < b</p>", "raw-lt"],
    ["a NUL", "<!doctype html><p>a\u0000b</p>", "nul"],
    ["style inside svg", "<!doctype html><svg><style>a{}</style></svg>", "raw-text-in-svg"],
    ["a comment opener in a script", "<!doctype html><script>x<!--y</script>", "raw-text-comment"],
    ["a closer variant in a script", "<!doctype html><script>x</SCRIPT >y</script>", "raw-text-closer"],
    ["a < in title", "<!doctype html><title>a<b</title>", "title-text"],
    ["an unterminated style", "<!doctype html><style>a{}", "unterminated"],
    ["an unclosed element", doc("", "<div><p>x</p>"), "unclosed"],
    ["a crossed pair", doc("", "<div><span>x</div></span>"), "end-tag"],
    ["a stray end tag", doc("", "<p>x</p></p>"), "end-tag"],
    ["an end tag on a void element", doc("", "<br></br>"), "end-tag"],
    ["a second head", doc("", "<head></head>"), "structure"],
    ["a second body", doc("", "<body></body>"), "structure"],
    ["a second html", doc("", "<html></html>"), "structure"],
    ["a head-only element in body", doc("", '<meta charset="utf-8">'), "structure"],
    ["a body element in head", doc("<p>x</p>", ""), "structure"],
    ["text in head", doc("x", ""), "structure"],
    ["content after </html>", doc("", "") + "<p>x</p>", "structure"],
    ["text after </html>", doc("", "") + "x", "structure"],
    ["no html at all", "<!doctype html><p>x</p>", "structure"],
    ["a block inside p", doc("", "<p><div>x</div></p>"), "content"],
    ["a heading inside a heading", doc("", "<h2><h3>x</h3></h2>"), "content"],
    ["a link inside a link", doc("", '<a href="#a"><a href="#b">x</a></a>'), "content"],
    ["li outside a list", doc("", "<div><li>x</li></div>"), "content"],
    ["tr straight in table", doc("", "<table><tr><td>x</td></tr></table>"), "content"],
    ["text in a table", doc("", "<table>x<tbody></tbody></table>"), "structure"],
    ["an element in svg title", doc("", "<svg><title><b>x</b></title></svg>"), "svg-text"],
    ["a CSS escape cssString never writes", "<!doctype html><style>\\75 rl(x)</style>", "css-escape"],
    ["no charset: the head's first child is not the charset meta", doc('<meta name="referrer" content="no-referrer">', ""), "charset"],
    ["an empty head", doc("", ""), "charset"],
    ["ESC in text", doc('<meta charset="utf-8">', "<p>a\u001bb</p>"), "control"],
    ["a C0 control in an attribute value", doc('<meta charset="utf-8">', '<p title="a\u0001b">x</p>'), "control"],
    ["a C0 control in the title", doc('<meta charset="utf-8"><title>a\u0008b</title>', ""), "control"],
    ["a C0 control in style text", doc('<meta charset="utf-8"><style>a{}\u001f</style>', ""), "control"],
    ["a C0 control in script text", doc('<meta charset="utf-8">', "<script>1\u000b</script>"), "control"],
    ["a form feed", doc('<meta charset="utf-8">', "<p>a\u000cb</p>"), "control"],
    ["an entity in a paint attribute", doc('<meta charset="utf-8">', '<svg><rect fill="&#117;rl(https://x)"/></svg>'), "paint-escape"],
    ["a backslash in a paint attribute", doc('<meta charset="utf-8">', '<svg><rect stroke="u\\72l(https://x)"/></svg>'), "paint-escape"],
    ["an entity in a marker attribute", doc('<meta charset="utf-8">', '<svg><path d="M0 0" marker-end="&#x75;rl(//x)"/></svg>'), "paint-escape"],
  ];
  for (const [label, html, code] of cases) {
    test(label, () => {
      expect(codes(auditHtml(html))).toContain(code);
    });
  }

  test("findings are constant codes and offsets, never document text", () => {
    const a = auditHtml("<!-- Jordan Example --><P CLASS=secret>x</P>");
    expect(a.nonCanonical.length).toBeGreaterThan(0);
    for (const f of a.nonCanonical) expect(f).toMatch(/^(?:[a-z-]+ at \d+|more \d+)$/);
    expect(a.nonCanonical.join(" ")).not.toMatch(/Jordan|secret/);
  });

  test("findings are capped, with a count of the rest", () => {
    const a = auditHtml("<!doctype html>" + "<!-- -->".repeat(80));
    expect(a.nonCanonical.length).toBe(51);
    expect(a.nonCanonical.at(-1)).toMatch(/^more \d+$/);
  });

  test("the element lists are exported for renderers to extend deliberately", () => {
    expect(HTML_ELEMENTS).toContain("figure");
    expect(SVG_ELEMENTS).toContain("textPath");
    expect(HTML_ELEMENTS).not.toContain("iframe");
  });
});

describe("auditHtml: URL attributes match literally", () => {
  test("a fragment or nothing; srcset never; no trimming, no entity decoding", () => {
    expect(auditHtml('<!doctype html><a href="#ex-c">x</a>').externalRefs).toEqual([]);
    for (const [html, ref] of [
      ['<a href=" #x">x</a>', "href= #x"],
      ['<a href="&num1">x</a>', "href=&num1"],
      ['<a href="&#35;x">x</a>', "href=&#35;x"],
      ['<a href="#\tx">x</a>', "href=#\tx"],
      ['<a href="data:image/png;base64,AA">x</a>', "href=data:image/png;base64,AA"],
      ['<a href="#x" ping="https://t">x</a>', "ping=https://t"],
      ['<blockquote cite="https://x">x</blockquote>', "cite=https://x"],
      ['<p background="#x">x</p>', ""],
    ] as const) {
      const refs = auditHtml(`<!doctype html>${html}`).externalRefs;
      if (ref === "") expect([html, refs]).toEqual([html, []]);
      else expect([html, refs]).toEqual([html, [ref]]);
    }
    expect(auditHtml('<!doctype html><svg><use xlink:href="#a" href="#b"/></svg>').externalRefs).toEqual([]);
    expect(auditHtml('<!doctype html><svg><rect srcset="#a"/></svg>').externalRefs).toEqual(["srcset=#a"]);
  });

  test("SVG paint url() is only an id; CSS url() only an id or font or image data", () => {
    expect(auditHtml('<!doctype html><svg><rect fill="url(#kit-hatch)"/></svg>').externalRefs).toEqual([]);
    expect(auditHtml('<!doctype html><svg><rect fill="url(https://x#p)"/></svg>').externalRefs).toEqual(["url(https://x#p)"]);
    expect(auditHtml('<!doctype html><svg><rect fill="URL(#p)"/></svg>').externalRefs).toEqual(["url(#p)"]);
    expect(auditHtml("<!doctype html><style>a{src:url(data:font/woff2;base64,AA)}</style>").externalRefs).toEqual([]);
    expect(auditHtml('<!doctype html><style>a{src:url("data:font/woff2;base64,AA")}</style>').externalRefs.length).toBe(1);
    expect(auditHtml('<!doctype html><style>a{background:image-set("x" 1x)}</style>').externalRefs.length).toBe(1);
  });

  test("a paint attribute holding & or \\ is a finding: entity or CSS escapes could spell url(", () => {
    for (const v of ["&#117;rl(https://x)", "&#x55;RL(//x)", "u&#114;l(x)", "&amp;", "u\\72l(https://x)", "\\75 rl(x)", "url(#a)\\"]) {
      for (const key of ["fill", "stroke", "mask", "clip-path", "filter", "marker-start", "marker-mid", "marker-end", "marker", "cursor"]) {
        const a = auditHtml(`<!doctype html><svg><rect ${key}="${v}"/></svg>`);
        expect([key, v, codes(a).includes("paint-escape")]).toEqual([key, v, true]);
      }
    }
    expect(codes(auditHtml('<!doctype html><svg><rect fill="url(#kit-hatch)" stroke="#000"/></svg>'))).not.toContain("paint-escape");
  });

  test("a meta refresh is a reference in any case or quoting", () => {
    expect(auditHtml('<!doctype html><meta http-equiv="refresh" content="0">').externalRefs).toEqual(["<meta refresh>"]);
    expect(auditHtml('<!doctype html><meta http-equiv="REFRESH " content="0">').externalRefs).toEqual(["<meta refresh>"]);
    expect(codes(auditHtml("<!doctype html><META HTTP-EQUIV=Refresh CONTENT=0>"))).toContain("element");
  });
});

/** Every probe from both review rounds, each placed inside a clean page. */
const PROBES: [string, string][] = [
  ["<!-->", '<!--><img src="https://evil"><!-- -->'],
  ["<!--->", '<!---><img src="https://evil"><!-- -->'],
  ["quote as attribute name", '<img "x" src="https://evil" onerror="a()" style="c">'],
  ["srcset data split", '<img srcset="data:image/png;base64,AA 1x,evil.png 2x">'],
  ["srcset nested parens", '<img srcset="data:,a 1x((),https://evil 2x">'],
  ["quote name and NBSP", '<x "\u00a0=" ><img src="https://evil">"'],
  ["title hides meta refresh", '<title><!--</title><meta http-equiv=refresh content="0;url=https://evil">-->'],
  ["textarea hides", '<textarea><!--</textarea><img src="https://evil">-->'],
  ["noscript hides", '<noscript><!--</noscript><img src="https://evil">-->'],
  ["iframe hides", '<iframe><!--</iframe><img src="https://evil">-->'],
  ["xmp hides", '<xmp><!--</xmp><img src="https://evil">-->'],
  ["script double-escape", '<script><!--<script>x</script>y<!--</script><img src="https://evil">-->'],
  ["script closer with VT", '<script>x="</script\u000b>";/*<!--*/</script><img src="https://evil">-->'],
  ["end tag with attributes", '</p a=">" b="<!--"><img src="https://evil">-->'],
  ["svg style", '<svg><style><image href="https://evil"/></style></svg>'],
  ["svg CDATA", '<svg><![CDATA[a>b<!--]]><image href="https://evil"/><!---->'],
  ["math style", '<math><style><img src="https://evil"></style></math>'],
  ["leading space before #", '<a href=" #x">x</a>'],
  ["&num1", '<a href="&num1">x</a>'],
  ["== src", "<img == src=https://evil>"],
  ["upper case", '<IMG SRC="https://evil">'],
  ["dup src, first local", '<a href="#x" href="https://evil">x</a>'],
  ["newline inside a value", '<a href="htt\nps://evil">x</a>'],
  ["svg a href", '<svg><a href="https://evil"><text>x</text></a></svg>'],
  ["svg set to href", '<svg><set attributeName="href" to="https://evil"/></svg>'],
];

describe("auditHtml: every review probe is flagged", () => {
  for (const [label, probe] of PROBES) {
    test(label, () => {
      expect(clean(auditHtml(inPage(probe)))).toBe(false);
    });
  }
});

describe("auditHtml: property — no hostile insertion into a clean page audits clean", () => {
  const INSERTIONS: string[] = [
    ...PROBES.map(([, p]) => p),
    "<!-- -->", "<!---->", "<![CDATA[x]]>", "<?xml?>", "<!x>",
    '<link rel="stylesheet" href="x.css">', '<base href="https://x/">', '<object data="x"></object>', "<embed>",
    '<iframe src="x"></iframe>', '<img src="x.png">', '<video poster="x"></video>', '<audio src="x"></audio>',
    '<form action="https://x"><button>x</button></form>', '<button formaction="https://x">x</button>',
    '<a href="javascript:x()">x</a>', '<a href="//x">x</a>', '<a href="x">x</a>', '<a href="">x</a>',
    '<meta http-equiv="refresh" content="0">', '<meta name="description" content="x">',
    '<p style="color:red">x</p>', '<p onclick="x()">x</p>', '<p ONCLICK="x()">x</p>',
    "<script>x()</script>", '<script src="x.js"></script>', '<script type="application/json">{"a":"<!--"}</script>',
    "<style>a{}</style>", "<style>@import 'x';</style>", "<style>a{background:url(x.png)}</style>",
    "<svg><script>x()</script></svg>", "<svg><foreignObject><p>x</p></foreignObject></svg>", '<svg><image href="x.png"/></svg>',
    '<svg><use href="x.svg#a"/></svg>', '<svg><rect fill="url(x.svg#p)"/></svg>',
    "<title>a<b</title>", "<template><p>x</p></template>", "<plaintext>", "<noembed>x</noembed>", "<noframes>x</noframes>",
    // nesting and structure
    "<div>", "<p>", "<span>", "<svg>", "</div>", "</main>", "<div><span></div></span>", "<b><i></b></i>",
    "<head></head>", "<body></body>", "<html></html>", "<head>", "<body>", '<meta charset="utf-8">', "<title>t</title>", "<style>a{}</style>",
    "<p><div>x</div></p>", "<p><table><tbody></tbody></table></p>", "<h2><h3>x</h3></h2>", "<button><button>x</button></button>",
    "<li>x</li>", "<dd>x</dd>", "<table><tr><td>x</td></tr></table>", "<table><div>x</div></table>", "<table>text</table>",
    "<svg><title><b>x</b></title></svg>", "<svg><desc><p>x</p></desc></svg>", "<svg><title><title></svg></title></title>",
    "<p>a < b</p>", "<p>a\u0000b</p>", "<div/>", "<p class=x>y</p>", "<p class='x'>y</p>", "<details open>x</details>",
    '<p\tclass="x">y</p>', '<p class="a" class="b">y</p>', '<p a="1"b="2">y</p>', "</p x>", "</P>", "<math><mi>x</mi></math>",
    // C0 controls and escaped paint url()
    "<p>a\u001bb</p>", "<p>a\u0001b</p>", '<p title="\u001b[31m">x</p>', "<p>a\u000cb</p>", "<p>a\u007fb\u0019</p>",
    '<svg><rect fill="&#117;rl(https://x)"/></svg>', '<svg><rect fill="u\\72l(https://x)"/></svg>', '<svg><rect mask="&#x75;rl(x.svg#m)"/></svg>',
    '<svg><rect filter="\\75 rl(x.svg#f)"/></svg>', '<svg><rect cursor="&#117;rl(x.cur),auto"/></svg>', '<svg><rect clip-path="&amp;"/></svg>',
  ];

  test("the table holds about 60 insertions or more", () => {
    expect(INSERTIONS.length).toBeGreaterThanOrEqual(60);
  });

  for (const [i, ins] of INSERTIONS.entries()) {
    test(`insertion ${i}`, () => {
      expect(clean(auditHtml(inPage(ins)))).toBe(false);
    });
  }
});

describe("auditHtml: property — no edit of a clean page's head that drops the leading charset audits clean", () => {
  const base = page({ ...PAGE, body: "<main></main>" });
  const CHARSET = '<meta charset="utf-8">';
  const EDITS: [string, (h: string) => string][] = [
    ["charset swapped for another allowed meta", (h) => h.replace(CHARSET, '<meta name="referrer" content="no-referrer">')],
    ["charset upper-case", (h) => h.replace(CHARSET, '<meta charset="UTF-8">')],
    ["charset another encoding", (h) => h.replace(CHARSET, '<meta charset="windows-1252">')],
    ["charset removed", (h) => h.replace(CHARSET, "")],
    ["charset moved after the CSP", (h) => h.replace(CHARSET, "").replace("<title>", `${CHARSET}<title>`)],
    ["a meta before the charset", (h) => h.replace("<head>", '<head><meta name="color-scheme" content="dark light">')],
    ["charset with a newline separator", (h) => h.replace(CHARSET, '<meta\ncharset="utf-8">')],
    ["charset pushed past 1,024 bytes", (h) => h.replace('lang="en"', `lang="${"e".repeat(1100)}"`)],
    ["ESC in the title", (h) => h.replace("<title>", "<title>\u001b")],
    ["ESC in the style", (h) => h.replace("</style>", "\u001b</style>")],
  ];

  test("the base page audits clean", () => {
    expect(clean(auditHtml(base))).toBe(true);
  });

  for (const [label, edit] of EDITS) {
    test(label, () => {
      const html = edit(base);
      expect(html).not.toBe(base);
      expect(clean(auditHtml(html))).toBe(false);
    });
  }
});

/** Inserts `before` and `after` around the clean page's markers. */
const splice = (html: string, marks: [string, string, "before" | "after"][]): string =>
  marks.reduce((h, [mark, ins, where]) => h.replace(mark, where === "after" ? mark + ins : ins + mark), html);

describe("auditHtml: the round-3 probes, where WebKit ran an unhashed script, are not clean", () => {
  test("body probe: a title inside an svg title hides </svg>, so the island is an SVG script", () => {
    const probe = '<svg><title><title></svg></title></title><script type="application/json"><img src="https://evil.example/x.png"></script></svg>';
    expect(clean(auditHtml(inPage(probe)))).toBe(false);
  });

  test("combined probe: the same with an onerror image in the island", () => {
    const probe = '<svg><title><title></svg></title></title><script type="application/json"><img src="data:," onerror="alert(1)"></script></svg>';
    const a = auditHtml(inPage(probe));
    expect(clean(a)).toBe(false);
    expect(codes(a)).toContain("svg-text");
  });

  test("head probe: the CSP meta swallowed into title text", () => {
    const html = splice(page({ ...PAGE, body: "<main></main>" }), [
      ["<head>", "<svg><title><title></svg><head>", "after"],
      ["</title>", "</title></svg>", "after"],
    ]);
    expect(clean(auditHtml(html))).toBe(false);
  });

  test("second-head probe: a CSP meta moved into body behind another head is not the page's CSP", () => {
    const base = page({ ...PAGE, body: "<main></main>" });
    const meta = base.match(/<meta http-equiv="Content-Security-Policy" content="[^"]*">/)![0];
    const html = base.replace(meta, "").replace("<body>", `<body><head><meta charset="utf-8">${meta}</head>`);
    const a = auditHtml(html);
    expect(clean(a)).toBe(false);
    expect(a.cspOk).toBe(false);
  });
});

describe("auditHtml on page() output", () => {
  test("with and without fonts, in all three themes, the page audits clean", () => {
    for (const fonts of ["embed", "none"] as const) {
      for (const theme of ["auto", "ink", "paper"] as const) {
        const a = auditHtml(page({ ...PAGE, fonts, theme, body: "<main><h1>Jordan Example</h1></main>" }));
        expect([fonts, theme, clean(a), a.nonCanonical, a.externalRefs, a.uncovered]).toEqual([fonts, theme, true, [], [], []]);
      }
    }
  });

  test("uncovered lists characters no embedded font covers", () => {
    expect(auditHtml("<!doctype html><p>a→b</p>").uncovered).toEqual(["→"]);
  });
});

describe("auditHtml: ids", () => {
  test("a page with two equal ids is never clean; distinct ids are", () => {
    expect(clean(auditHtml(inPage('<p id="x">a</p><p id="y">b</p>')))).toBe(true);
    const a = auditHtml(inPage('<p id="x">a</p><svg><path id="x" d="M0 0"/></svg>'));
    expect([clean(a), codes(a)]).toEqual([false, ["duplicate-id"]]);
  });
});
