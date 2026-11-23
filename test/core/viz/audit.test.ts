import { describe, expect, test } from "bun:test";
import { auditHtml } from "../../../core/viz/audit";
import { cspFor, page } from "../../../core/viz/page";

const doc = (head: string, body: string): string => `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;
const csp = (style: string, script: string): string => `<meta http-equiv="Content-Security-Policy" content="${cspFor(style, script)}">`;

describe("auditHtml: a crafted document", () => {
  const html = doc(`<meta charset="utf-8"><title>t</title><style>a{background:url(//x)}@import "y";</style><link href="z">`,
    `<img src="https://x"><p style="color:red" onclick="x()">t</p><a href="#ok">ok</a><img src="data:image/png;base64,AA">`);
  const a = auditHtml(html);

  test("it reports each external reference, by kind", () => {
    expect(a.externalRefs).toEqual(expect.arrayContaining(["src=https://x", "url(//x)", "@import y", "href=z", "<link>"]));
    expect(a.externalRefs.some((r) => r.includes("#ok") || r.includes("data:"))).toBe(false);
  });

  test("it counts style attributes and inline handlers", () => {
    expect(a.styleAttrs).toBe(1);
    expect(a.inlineHandlers).toBe(1);
  });

  test("no CSP: csp is null and cspOk false", () => {
    expect(a.csp).toBeNull();
    expect(a.cspOk).toBe(false);
  });

  test("bytes are UTF-8 bytes; elements count start tags", () => {
    expect(auditHtml("<p>·</p>").bytes).toBe(9);
    expect(auditHtml("<p>·</p>").elements).toBe(1);
  });
});

describe("auditHtml: the other attributes and elements it lists", () => {
  test("action, formaction, poster, srcset, xlink:href, data and SVG url() attributes", () => {
    const a = auditHtml(`<form action="/a"></form><button formaction="b"></button><video poster="c"></video>`
      + `<img srcset="data:image/png;base64,AA 1x, d.png 2x"><svg><use xlink:href="e.svg#i"/><rect fill="url(f.svg#p)"/></svg>`
      + `<object data="g"></object><iframe></iframe><embed><base href="#">`);
    expect(a.externalRefs).toEqual(expect.arrayContaining(["action=/a", "formaction=b", "poster=c", "xlink:href=e.svg#i", "data=g",
      "url(f.svg#p)", "<object>", "<iframe>", "<embed>", "<base>"]));
    expect(a.externalRefs.some((r) => r.startsWith("srcset="))).toBe(true);
  });

  test("entity-encoded and unquoted targets are still seen", () => {
    expect(auditHtml(`<img src="&#x68;ttps://x">`).externalRefs).toEqual(["src=https://x"]);
    expect(auditHtml(`<img src=https://x>`).externalRefs).toEqual(["src=https://x"]);
    expect(auditHtml(`<IMG SRC='//x'>`).externalRefs).toEqual(["src=//x"]);
  });

  test("references to #… and data:… are not listed", () => {
    const a = auditHtml(`<a href="#x">x</a><rect fill="url(#kit-hatch)"/><style>a{src:url(data:font/woff2;base64,AA)}</style>`);
    expect(a.externalRefs).toEqual([]);
  });
});

describe("auditHtml: elements", () => {
  test("start tags inside script, style and pre are not counted; the elements themselves are", () => {
    const a = auditHtml(`<div><pre><b>x</b><i>y</i></pre><script>"<p><p><p>"</script><style>/*<p>*/</style><!-- <p> --></div>`);
    expect(a.elements).toBe(4);
  });
});

describe("auditHtml: cspOk", () => {
  const S = "a{}";
  const J = "void 0;";

  test("true for a CSP second in head that pins the one style and the one script", () => {
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

  test("csp holds the policy text", () => {
    expect(auditHtml(doc(`<meta charset="utf-8">${csp(S, J)}`, "")).csp).toBe(cspFor(S, J));
  });
});

describe("auditHtml on page() output, fonts embedded", () => {
  const a = auditHtml(page({ title: "Your practice", footerLeft: "Jordan Example · No. 7F3A-91C2", body: "<main><h1>Jordan Example</h1></main>" }));

  test("no external references, style attributes, inline handlers or uncovered characters; the CSP holds", () => {
    expect(a.externalRefs).toEqual([]);
    expect(a.styleAttrs).toBe(0);
    expect(a.inlineHandlers).toBe(0);
    expect(a.uncovered).toEqual([]);
    expect(a.cspOk).toBe(true);
  });

  test("uncovered lists characters no embedded font covers", () => {
    expect(auditHtml("<p>a→b</p>").uncovered).toEqual(["→"]);
  });
});

describe("auditHtml: the tokenizer stays in step with the browser (review fix 1)", () => {
  test("abrupt empty comments <!--> and <!---> close at once", () => {
    for (const open of ["<!-->", "<!--->"]) {
      const a = auditHtml(`${open}<img src="https://evil"><!-- -->`);
      expect([open, a.externalRefs, a.elements]).toEqual([open, ["src=https://evil"], 1]);
    }
    expect(auditHtml(`<!-- x --!><img src="https://evil">`).externalRefs).toEqual(["src=https://evil"]);
  });

  test("an attribute name may start with a quote or an equals sign", () => {
    const a = auditHtml(`<img "x" src="https://evil" onerror="a()" style="c">`);
    expect([a.externalRefs, a.inlineHandlers, a.styleAttrs]).toEqual([["src=https://evil"], 1, 1]);
    expect(auditHtml(`<img = src="https://evil">`).externalRefs).toEqual(["src=https://evil"]);
    // As the browser reads it: the name `'y'` takes the bare value `src="https://evil"`, so nothing loads.
    expect(auditHtml(`<img 'y' = src="https://evil">`).externalRefs).toEqual([]);
  });

  test("srcset candidates are parsed as the spec reads them: URL up to white space, descriptors up to a comma", () => {
    expect(auditHtml(`<img srcset="data:image/png;base64,AA 1x,evil.png 2x">`).externalRefs)
      .toEqual(["srcset=data:image/png;base64,AA 1x,evil.png 2x"]);
    expect(auditHtml(`<img srcset="data:image/png;base64,AA 1x, data:image/png;base64,BB 2x">`).externalRefs).toEqual([]);
    expect(auditHtml(`<img srcset="#a, evil.png">`).externalRefs).toEqual(["srcset=#a, evil.png"]);
    // One candidate with no white space is one URL, commas and all: a fragment here.
    expect(auditHtml(`<img srcset="#a,,evil.png">`).externalRefs).toEqual([]);
  });
});

describe("auditHtml: navigation CSP does not block (ruled addition)", () => {
  test("a meta refresh is reported in any case or quoting", () => {
    for (const m of [`<meta http-equiv="refresh" content="0;url=https://x">`, `<META HTTP-EQUIV=Refresh CONTENT="0">`, `<meta http-equiv='REFRESH ' content='5'>`]) {
      expect([m, auditHtml(m).externalRefs]).toEqual([m, ["<meta refresh>"]]);
    }
  });

  test("ping and background are URL attributes", () => {
    expect(auditHtml(`<a href="#x" ping="https://track">x</a>`).externalRefs).toEqual(["ping=https://track"]);
    expect(auditHtml(`<a href="#x" ping="#a https://track">x</a>`).externalRefs).toEqual(["ping=#a https://track"]);
    expect(auditHtml(`<body background="bg.png"></body>`).externalRefs).toEqual(["background=bg.png"]);
    expect(auditHtml(`<td background="data:image/png;base64,AA"></td>`).externalRefs).toEqual([]);
  });
});
