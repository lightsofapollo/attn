"use strict";(()=>{var Z="attn:doc:hello",J="attn:shell:init";var ft=new TextEncoder;var Re=new TextEncoder;function g(e){return Re.encode(e).length}function S(e,t,n){let o=0,s=0,r=0;for(let i of e){let l=g(i);if(s+1>t||o+l>n)break;o+=l,s+=1,r+=i.length}return r===e.length?e:e.slice(0,r)}function re(e){return e.ownerDocument.createTreeWalker(e,NodeFilter.SHOW_TEXT)}function x(e,t,n){if(t.nodeType!==Node.TEXT_NODE){let i=e.ownerDocument.createRange();return i.selectNodeContents(e),i.setEnd(t,n),g(i.toString())}let o=0,s=re(e),r=s.nextNode();for(;r;){if(r===t)return o+g((r.nodeValue??"").slice(0,n));o+=g(r.nodeValue??""),r=s.nextNode()}return o}function ee(e,t){let n=0,o=re(e),s=o.nextNode(),r=null;for(;s;){let i=s.nodeValue??"",l=g(i);if(n+l>=t){let c=0,d=0;for(let u of i){if(n+c>=t)return{node:s,offset:d};c+=g(u),d+=u.length}return{node:s,offset:i.length}}n+=l,r={node:s,offset:i.length},s=o.nextNode()}return r}function $(e,t,n){let o=ee(e,t),s=ee(e,n);if(!o||!s)return null;let r=e.ownerDocument.createRange();try{r.setStart(o.node,o.offset),r.setEnd(s.node,s.offset)}catch{return null}return r}function Y(e){return e.textContent??""}var Oe=new Set(["TD","TH"]),_e=e=>Oe.has(e.tagName);function Le(e){let t=e.parentElement;return t?Array.from(t.children).filter(n=>n.tagName==="TR").indexOf(e)+1:1}function D(e){let t=e.parentElement;if(!t)return"";let n=Array.from(t.children).filter(o=>o.tagName===e.tagName);return n.length<=1?"":`:nth-of-type(${n.indexOf(e)+1})`}function se(e){return e.length===0||e.length>64||!/^[A-Za-z][\w-]*$/.test(e)||/^(react|radix|mui|headless|aria)[-_]/i.test(e)?!1:!/[0-9a-f]{8,}/i.test(e)}function ie(e){if(typeof e.className!="string")return"";let t=e.className.trim().split(/\s+/).filter(Boolean);for(let n of t)if(/^[\w-]+$/.test(n)&&n.length<=40&&!/[0-9a-f]{6,}/i.test(n))return`.${CSS.escape(n)}`;return""}function ce(e){let t=e.parentElement,n=e.closest("table"),o=[n?A(n):"table"];return t&&t!==n&&o.push(t.tagName.toLowerCase()),o.push(`tr:nth-of-type(${Le(e)})`),o.join(" > ")}function Ne(e){let t=e.closest("tr");if(!t)return e.tagName.toLowerCase();let n=Array.from(t.children).filter(o=>o.tagName===e.tagName);return`${ce(t)} > ${e.tagName.toLowerCase()}:nth-of-type(${n.indexOf(e)+1})`}function A(e){return e.id&&se(e.id)?`#${CSS.escape(e.id)}`:e.tagName==="TR"?ce(e):_e(e)?Ne(e):`${e.tagName.toLowerCase()}${ie(e)}${D(e)}`}function le(e){let t=[],n=c=>{c&&!t.includes(c)&&t.length<8&&t.push(c)},o=[],s=e;for(;s&&s.tagName!=="BODY"&&o.length<12;)o.unshift(`${s.tagName.toLowerCase()}${D(s)}`),s=s.parentElement;o.length>0&&n(o.join(" > "));let r=e.parentElement,i=[`${e.tagName.toLowerCase()}${D(e)}`];for(;r&&r.tagName!=="BODY"&&i.length<6;){if(r.id&&se(r.id)){n(`#${CSS.escape(r.id)} ${i.join(" > ")}`);break}i.unshift(`${r.tagName.toLowerCase()}${D(r)}`),r=r.parentElement}let l=ie(e);return l&&n(`${e.tagName.toLowerCase()}${l}`),t.filter(c=>c!==A(e))}var ke={TR:"row",TD:"cell",TH:"columnheader",TABLE:"table",LI:"listitem",UL:"list",OL:"list",P:"paragraph",BLOCKQUOTE:"blockquote",FIGURE:"figure",IMG:"img",H1:"heading",H2:"heading",H3:"heading",H4:"heading"};function ae(e,t){let n=[],o=e;for(;o&&o.tagName!=="BODY"&&n.length<8;)n.unshift(o.tagName.toLowerCase()),o=o.parentElement;let s=e.getAttribute("role")??ke[e.tagName],r={tagName:e.tagName.toLowerCase(),scopePreview:S(t,200,256),domPath:n};return s&&(r.role=s),r}function Me(e,t){let n=t.startContainer.nodeType===Node.ELEMENT_NODE?t.startContainer:t.startContainer.parentElement,o=t.endContainer.nodeType===Node.ELEMENT_NODE?t.endContainer:t.endContainer.parentElement;return!n||!o||n===o?null:{startSelector:A(n),startOffset:x(n,t.startContainer,t.startOffset),endSelector:A(o),endOffset:x(o,t.endContainer,t.endOffset)}}function ue(e,t){let n=t.commonAncestorContainer.nodeType===Node.ELEMENT_NODE?t.commonAncestorContainer:t.commonAncestorContainer.parentElement??e,o=x(e,t.startContainer,t.startOffset),s=x(e,t.endContainer,t.endOffset),r={v:1,target:"text_range",cssSelector:A(n),fallbackSelectors:le(n),textPosition:{start:o,end:s},context:ae(n,S(t.toString(),120,256))},i=Me(e,t);return i&&(r.range=i),r}function G(e,t,n){let o=e.ownerDocument.createRange();return o.selectNodeContents(t),{v:1,target:"element",cssSelector:A(t),fallbackSelectors:le(t),textPosition:{start:x(e,o.startContainer,o.startOffset),end:x(e,o.endContainer,o.endOffset)},context:ae(t,n)}}var te={range:null,element:null,status:"stale",confidence:0};function Ie(e){return e.replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/[–—]/g,"-").replace(/\s+/g," ").trim()}function De(e){let t=[],n=[],o=[],s=-1;for(let r=0;r<e.length;r+=1){let i=e[r];if(/\s/.test(i)){s===-1&&(s=r);continue}i==="\u2018"||i==="\u2019"?i="'":i==="\u201C"||i==="\u201D"?i='"':(i==="\u2013"||i==="\u2014")&&(i="-"),s!==-1&&t.length>0&&(t.push(" "),n.push(s),o.push(r)),s=-1,t.push(i),n.push(r),o.push(r+1)}return{normalized:t.join(""),starts:n,ends:o}}function L(e,t){try{return e.querySelector(t)}catch{return null}}function ne(e,t){let n=[];if(t.length===0)return n;let o=0;for(;;){let s=e.indexOf(t,o);if(s===-1||(n.push(s),o=s+1,n.length>64))return n}}function oe(e,t){let n=Math.min(e.length,t.length),o=0;for(;o<n&&e[o]===t[o];)o+=1;return o}function He(e,t,n,o,s){let r=t.map(l=>{let c=e.slice(Math.max(0,l-o.length),l),d=e.slice(l+n,l+n+s.length),u=oe([...c].reverse().join(""),[...o].reverse().join(""))+oe(d,s);return{at:l,score:u}});r.sort((l,c)=>c.score-l.score);let i=r.length>1&&r[0].score===r[1].score;return{index:r[0].at,ambiguous:i}}function de(e,t){let{anchor:n,quote:o,prefix:s="",suffix:r=""}=t;if(n.target==="element"){let c=L(e,n.cssSelector)??(n.fallbackSelectors??[]).reduce((w,C)=>w??L(e,C),null);if(!c)return te;let d=e.ownerDocument.createRange();d.selectNodeContents(c);let u=L(e,n.cssSelector)===c;return{range:d,element:c,status:u?"exact":"remapped",confidence:u?1:.7}}let i=Y(e);if(o&&n.textPosition){let{start:c,end:d}=n.textPosition,u=$(e,c,d);if(u&&u.toString()===o)return{range:u,element:null,status:"exact",confidence:1}}if(o&&o.length>0){let c=ne(i,o);if(c.length>0){let{index:d,ambiguous:u}=He(i,c,o.length,s,r),w=g(i.slice(0,d)),C=$(e,w,w+g(o));if(C)return{range:C,element:null,status:u?"ambiguous":"remapped",confidence:u?.4:c.length===1?.9:.75}}}if(o){let c=Ie(o),{normalized:d,starts:u,ends:w}=De(i);if(c.length>0){let C=ne(d,c);if(C.length===1){let z=C[0],W=u[z],K=w[z+c.length-1];if(W!==void 0&&K!==void 0){let Ae=g(i.slice(0,W)),Te=g(i.slice(0,K)),Q=$(e,Ae,Te);if(Q)return{range:Q,element:null,status:"remapped",confidence:.6}}}}}let l=L(e,n.cssSelector)??(n.fallbackSelectors??[]).reduce((c,d)=>c??L(e,d),null);if(l){let c=e.ownerDocument.createRange();return c.selectNodeContents(l),{range:c,element:l,status:"remapped",confidence:.35}}return te}var fe=`
.attn-layer {
  position: absolute;
  inset: 0;
  /* The layer spans the document but must never intercept the cursor \u2014 only
     its individually re-enabled children (pins, chips, the pill) do. */
  pointer-events: none;
  z-index: 2147483000;
  --attn-comment-accent: oklch(0.62 0.13 82);
  --attn-element-accent: oklch(0.55 0.11 235);
  --attn-surface: oklch(0.95 0.010 76);
  --attn-ink: oklch(0.14 0.008 55);
  --attn-border: oklch(0.14 0.008 55 / 22%);
  --attn-shadow: 0 8px 24px oklch(0.20 0.02 55 / 18%);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}

[data-attn-theme="ink"] .attn-layer {
  --attn-surface: oklch(0.24 0.012 60);
  --attn-ink: oklch(0.93 0.008 78);
  --attn-border: oklch(0.93 0.008 78 / 22%);
  --attn-shadow: 0 8px 24px oklch(0 0 0 / 45%);
}

/* Text highlights \u2014 CSS Custom Highlight API, so no wrapper spans are ever
   injected into the document's DOM. */
::highlight(attn-text) {
  background-color: oklch(0.82 0.13 85 / 30%);
}
::highlight(attn-text-active) {
  background-color: oklch(0.80 0.16 82 / 52%);
}

/* Element overlay. The fill is inert so text underneath a commented element
   stays selectable \u2014 you can always comment on something inside something
   already commented on. */
.attn-overlay {
  position: absolute;
  pointer-events: none;
  border-radius: 4px;
  border: 1.5px solid color-mix(in oklch, var(--attn-element-accent) 60%, transparent);
  background: color-mix(in oklch, var(--attn-element-accent) 8%, transparent);
  transition: background 120ms ease, border-color 120ms ease;
}
.attn-overlay[data-state="active"] {
  border-color: var(--attn-element-accent);
  background: color-mix(in oklch, var(--attn-element-accent) 16%, transparent);
}
.attn-overlay[data-state="resolved"] {
  border-style: dashed;
  opacity: 0.55;
}

/* Persistent marker for a committed comment: visible without hovering, so the
   document reads as annotated at a glance. */
.attn-pin {
  position: absolute;
  pointer-events: auto;
  display: grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border: 1px solid var(--attn-border);
  border-radius: 999px;
  background: var(--attn-element-accent);
  color: oklch(0.98 0.005 78);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  box-shadow: var(--attn-shadow);
  transition: transform 120ms ease;
}
.attn-pin:hover,
.attn-pin[data-state="active"] {
  transform: scale(1.12);
}
.attn-pin[data-state="resolved"] {
  background: var(--attn-surface);
  color: var(--attn-ink);
}

/* The hover label: names what the cursor is pointing at, and its ancestors.
   The outer box is a HIT AREA, not the visible pill \u2014 the transparent bottom
   padding is a reach corridor between the label and the element it labels, so
   a cursor travelling up to the chip never passes over a third element that
   would re-target the hover and move the chip out from under it. Losing the
   chip mid-reach is exactly the bug this geometry exists to prevent. */
.attn-chip {
  position: absolute;
  display: none;
  pointer-events: auto;
  padding-bottom: 6px;
  max-width: min(90vw, 560px);
}
.attn-chip.is-visible { display: block; }

.attn-chip-body {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--attn-border);
  border-radius: 8px;
  background: var(--attn-surface);
  box-shadow: var(--attn-shadow);
  font-size: 11px;
  line-height: 1.4;
}

.attn-chip-sep {
  flex: none;
  padding: 0 1px;
  color: var(--attn-ink);
  opacity: 0.4;
}

.attn-chip-seg {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  padding: 3px 7px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--attn-ink);
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.attn-chip-seg:hover { background: color-mix(in oklch, var(--attn-ink) 10%, transparent); }
.attn-chip-seg.is-current {
  background: var(--attn-element-accent);
  color: oklch(0.98 0.005 78);
}
.attn-chip-seg.is-current:hover {
  background: color-mix(in oklch, var(--attn-element-accent) 88%, black);
}
.attn-chip-title { font-weight: 600; }
.attn-chip-preview {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.7;
  font-weight: 400;
}
.attn-chip-count {
  flex: none;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--attn-comment-accent);
  color: oklch(0.98 0.005 78);
  font-size: 9px;
  font-weight: 700;
}

/* Hover preview of exactly what a scope would anchor to. */
.attn-outline {
  position: absolute;
  pointer-events: none;
  border: 1.5px dashed var(--attn-element-accent);
  border-radius: 4px;
  background: color-mix(in oklch, var(--attn-element-accent) 6%, transparent);
}

/* Floating "Comment" affordance raised by a text selection. */
.attn-pill {
  position: absolute;
  pointer-events: auto;
  display: none;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border: 1px solid var(--attn-border);
  border-radius: 999px;
  background: var(--attn-surface);
  color: var(--attn-ink);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: var(--attn-shadow);
}
.attn-pill.is-visible { display: inline-flex; }
.attn-pill::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 2px;
  background: var(--attn-comment-accent);
}

@media (prefers-reduced-motion: reduce) {
  .attn-overlay,
  .attn-pin { transition: none; }
}
`;var Pe="attn-text",Be="attn-text-active",N=64,H=null,f,b,a,y,m,E=new Map,P=new Map,p=null,B=null,F=null,T=null,Xe=0,j=!1;function v(e){H?.postMessage(e)}function $e(e){return{x:e.x,y:e.y,width:e.width,height:e.height}}function O(e){return e?Array.from(e.getClientRects()).filter(n=>n.width>0&&n.height>0).slice(0,128).map($e):[]}var Ye=new Set(["TD","TH","TR","LI","FIGURE","PRE","CODE","TABLE","BLOCKQUOTE","H1","H2","H3","H4","H5","H6","P","IMG","FIGCAPTION","UL","OL","DL","DT","DD","SECTION","ARTICLE","ASIDE","HEADER","FOOTER","MAIN","NAV","DETAILS","SUMMARY","FORM","VIDEO","AUDIO","CANVAS","SVG","A","BUTTON","LABEL","INPUT","TEXTAREA","SELECT","HR"]),he=e=>e.tagName==="TD"||e.tagName==="TH";function Ge(e){let t=e;for(let n=0;t&&t!==f&&n<12;n+=1){let o=t.getBoundingClientRect();if(o.width>0&&o.height>0)return t;t=t.parentElement}return null}function Ve(e){let t=[],n=e;for(;n&&n!==f&&t.length<12;)Ye.has(n.tagName.toUpperCase())&&t.push(n),n=n.parentElement;if(t.length===0){let o=Ge(e);o&&t.push(o)}return t}function Ue(e){return e[0]}function ge(e){let t=e.parentElement;return t?Array.from(t.children).filter(n=>n.tagName==="TR").indexOf(e)+1:1}function Ee(e){return he(e)?"cell":e.tagName==="TR"?e.closest("thead")?"header row":`row ${ge(e)}`:e.tagName==="LI"?"list item":e.tagName==="PRE"?"code block":e.tagName==="UL"||e.tagName==="OL"?"list":e.tagName==="A"?"link":e.tagName==="IMG"?"image":e.tagName==="BLOCKQUOTE"?"quote":/^H[1-6]$/.test(e.tagName)?"heading":e.tagName.toLowerCase()}function xe(e){if(e.tagName==="TR"){let n=Array.from(e.querySelectorAll("th,td")).map(r=>r.textContent?.trim()??""),o=e.closest("thead")?"header row":`row ${ge(e)}`,s=[n[0],n[1]].filter(Boolean).join(" \xB7 ");return s?`${o} \xB7 ${s}`:o}if(he(e)){let n=e.closest("tr"),o=n?Array.from(n.children).indexOf(e):-1,r=e.closest("table")?.querySelector("thead tr")?.children[o]?.textContent?.trim(),i=e.textContent?.trim()??"";return r?`${r}: ${i}`:i}let t=e.textContent?.trim()??"";return t?t.slice(0,80):null}function Fe(e){let t=0;for(let n of E.values())n.element===e&&(t+=1);return t}function je(e){let t=f.ownerDocument.createRange();t.selectNodeContents(f),t.setEnd(e.startContainer,e.startOffset);let n=f.ownerDocument.createRange();n.selectNodeContents(f),n.setStart(e.endContainer,e.endOffset);let o=t.toString(),s=[...o.slice(-N*2)].slice(-N),r=[...n.toString().slice(0,N*2)].slice(0,N);if(s.length>0&&o.length>N*2){let i=s[0].charCodeAt(0);i>=56320&&i<=57343&&s.shift()}return{prefix:s.join(""),suffix:r.join("")}}function be(e){let t=x(f,e.startContainer,e.startOffset),n=x(f,e.endContainer,e.endOffset),o=e.toString(),{prefix:s,suffix:r}=je(e);return{html:ue(f,e),quote:S(o,4e3,4096),prefix:s,suffix:r,textStart:t,textEnd:n}}function qe(e){let t=xe(e)??Ee(e),n=G(f,e,t),o=S((e.textContent??"").trim(),4e3,4096);return{html:n,quote:o,prefix:"",suffix:"",textStart:n.textPosition?.start??0,textEnd:n.textPosition?.end??0}}function ze(){let e=window.getSelection();return!!e&&!e.isCollapsed&&e.rangeCount>0}function We(){let e=window.getSelection();if(!e||e.isCollapsed||e.rangeCount===0){T=null,ve(),v({type:"selectionCleared",v:1});return}let t=e.getRangeAt(0);if(t.toString().trim().length===0)return;T=t.cloneRange(),_();let n=O(t),o=n[n.length-1];Ke(o),v({type:"selection",v:1,proposal:be(t),rects:n,caret:o??{x:0,y:0,width:0,height:0},explicit:!1})}function Ke(e){e&&(m.style.left=`${e.x+e.width}px`,m.style.top=`${e.y+e.height+8}px`,m.classList.add("is-visible"))}function ve(){m.classList.remove("is-visible")}var Qe=160,pe=4,Ze=2,R=0;function Se(e){return e instanceof Node&&b.contains(e)}function M(){R&&(clearTimeout(R),R=0)}function Ce(){R||(R=setTimeout(()=>{R=0,_()},Qe))}function Je(e){if(!j)return;if(a.contains(e.target)){M();return}if(Se(e.target))return;if(ze()){_();return}let t=e.target;if(!(t instanceof Element))return;if(t===F){p&&M();return}F=t;let n=Ve(t),o=Ue(n);if(!o){Ce();return}M(),o!==p&&(p=o,I(o),nt(tt(n)))}function _(){M(),p=null,F=null,a.classList.remove("is-visible"),I(void 0)}function et(e){if(Se(e.target)||!j)return;let t=e.target;if(!(t instanceof Element))return;let n=B,o=p;!n||!o||o!==t&&!o.contains(t)||(e.preventDefault(),e.stopPropagation(),X(n))}function tt(e){P.clear();let t=e.slice(0,8).map(n=>{let o=`scope-${Xe+=1}`;P.set(o,n);let s=xe(n);return{scopeId:o,title:Ee(n),preview:s===null?null:S(s,200,256),selector:G(f,n,"").cssSelector,commentCount:Fe(n),rects:O(n)}});return v({type:"scopeHover",v:1,chain:t}),t}function nt(e){if(y.textContent="",B=e[0]?.scopeId??null,e.length===0){a.classList.remove("is-visible");return}let t=e.slice(0,pe).reverse(),n=e.length>pe;if(n){let o=document.createElement("span");o.className="attn-chip-sep",o.textContent="\u2026",y.appendChild(o)}t.forEach((o,s)=>{if(s>0||n){let c=document.createElement("span");c.className="attn-chip-sep",c.textContent="\u203A",c.setAttribute("aria-hidden","true"),y.appendChild(c)}let r=s===t.length-1,i=document.createElement("button");i.type="button",i.className="attn-chip-seg",r&&i.classList.add("is-current"),i.dataset.scope=o.scopeId,i.setAttribute("aria-label",`Comment on ${o.preview??o.title}`);let l=document.createElement("span");if(l.className="attn-chip-title",l.textContent=o.title,i.appendChild(l),r&&o.preview&&o.preview!==o.title){let c=document.createElement("span");c.className="attn-chip-preview",c.textContent=S(o.preview,48,192),i.appendChild(c)}if(o.commentCount>0){let c=document.createElement("span");c.className="attn-chip-count",c.textContent=String(o.commentCount),i.appendChild(c)}i.addEventListener("mouseenter",()=>I(P.get(o.scopeId))),i.addEventListener("mouseleave",()=>I(p??void 0)),i.addEventListener("mousedown",c=>c.preventDefault()),i.addEventListener("click",c=>{c.preventDefault(),c.stopPropagation(),X(o.scopeId)}),y.appendChild(i)}),a.classList.add("is-visible"),p&&ye(p)}function ye(e){let t=e.getBoundingClientRect(),n=t.top+window.scrollY,o=t.left+window.scrollX,s=a.offsetHeight,r=n-s+Ze;a.style.top=`${r<window.scrollY?n:r}px`;let i=document.documentElement.clientWidth-a.offsetWidth-2;a.style.left=`${Math.max(Math.min(o,window.scrollX+Math.max(i,0)),2)}px`}var k=null;function I(e){if(!e){k?.remove(),k=null;return}let t=e.getBoundingClientRect(),n=k??document.createElement("div");n.className="attn-outline",n.style.cssText=`top:${t.top+window.scrollY}px;left:${t.left+window.scrollX}px;width:${t.width}px;height:${t.height}px`,k||b.appendChild(n),k=n}function X(e){let t=P.get(e);t&&(_(),v({type:"scopePicked",v:1,proposal:qe(t),rects:O(t),explicit:!0}))}function q(){let e=CSS.highlights;if(!e||typeof Highlight>"u")return;let t=[],n=[];for(let o of E.values())o.spec.html.target!=="text_range"||!o.range||(o.spec.state==="active"?n:t).push(o.range);e.set(Pe,new Highlight(...t)),e.set(Be,new Highlight(...n))}function we(e){if(e.overlay?.remove(),e.pin?.remove(),e.overlay=null,e.pin=null,e.spec.html.target!=="element"||!e.element)return;let t=e.element.getBoundingClientRect(),n=t.top+window.scrollY,o=t.left+window.scrollX,s=document.createElement("div");s.className="attn-overlay",s.dataset.state=e.spec.state,s.style.cssText=`top:${n}px;left:${o}px;width:${t.width}px;height:${t.height}px`,b.appendChild(s),e.overlay=s;let r=document.createElement("button");r.type="button",r.className="attn-pin",r.dataset.state=e.spec.state,r.textContent=e.spec.label??"1",r.style.cssText=`top:${n-10}px;left:${o-14}px`,r.addEventListener("click",i=>{i.stopPropagation(),v({type:"anchorActivated",v:1,anchorId:e.spec.anchorId})}),b.appendChild(r),e.pin=r}function ot(e){let t=de(f,{anchor:e.html,quote:e.quote,prefix:e.prefix,suffix:e.suffix}),n={spec:e,range:t.range,element:t.element,status:t.status,confidence:t.confidence,overlay:null,pin:null};return we(n),n}function rt(e){for(let t of E.values())t.overlay?.remove(),t.pin?.remove();E.clear();for(let t of e)E.set(t.anchorId,ot(t));q(),st()}function st(){let e=[];for(let t of E.values())e.push({anchorId:t.spec.anchorId,status:t.status,confidence:t.confidence,rects:O(t.range??t.element)});v({type:"anchorsResolved",v:1,results:e})}function it(){let e=[];for(let t of E.values())e.push({anchorId:t.spec.anchorId,rects:O(t.range??t.element)});v({type:"geometry",v:1,results:e,scrollTop:window.scrollY})}function ct(e,t){let n=E.get(e);n&&(n.spec={...n.spec,state:t},n.overlay&&(n.overlay.dataset.state=t),n.pin&&(n.pin.dataset.state=t),q())}function lt(e,t){let n=E.get(e);if(!n||!t)return;(n.element??n.range?.startContainer.parentElement)?.scrollIntoView({behavior:"smooth",block:"center"})}var V=0;function U(){V||(V=requestAnimationFrame(()=>{V=0;for(let e of E.values())we(e);p&&!p.isConnected?_():p&&(I(p),ye(p)),q(),it()}))}function at(e){switch(e.type){case"renderAnchors":rt(e.anchors);break;case"setAnchorState":ct(e.anchorId,e.state);break;case"focusAnchor":lt(e.anchorId,e.scrollIntoView);break;case"pickScope":X(e.scopeId);break;case"dismissSelection":window.getSelection()?.removeAllRanges(),T=null,ve();break;case"inspect":j=e.enabled===!0;break;case"theme":f.dataset.attnTheme=e.mode;break;default:break}}function ut(){let e=document.createElement("style");e.textContent=fe,document.head.appendChild(e),b=document.createElement("div"),b.className="attn-layer",document.body.appendChild(b),a=document.createElement("div"),a.className="attn-chip",a.setAttribute("role","toolbar"),a.setAttribute("aria-label","Comment on this element"),a.addEventListener("mouseenter",M),a.addEventListener("mouseleave",Ce),a.addEventListener("mousedown",t=>t.preventDefault()),a.addEventListener("click",t=>{let n=t.target;n instanceof Element&&n.closest(".attn-chip-seg")||(t.preventDefault(),t.stopPropagation(),B&&X(B))}),y=document.createElement("div"),y.className="attn-chip-body",a.appendChild(y),b.appendChild(a),m=document.createElement("button"),m.type="button",m.className="attn-pill",m.textContent="Comment",m.addEventListener("mousedown",t=>t.preventDefault()),m.addEventListener("click",t=>{if(t.preventDefault(),t.stopPropagation(),!T)return;let n=O(T);v({type:"selection",v:1,proposal:be(T),rects:n,caret:n[n.length-1]??{x:0,y:0,width:0,height:0},explicit:!0})}),b.appendChild(m)}function dt(e){H=e,H.onmessage=t=>{let n=t.data;!n||typeof n!="object"||typeof n.type!="string"||n.v===1&&at(n)},H.start(),v({type:"ready",v:1,textLength:Y(f).length,title:S(document.title,200,512)})}function me(){let e=window;e.__attnDocRuntime||(e.__attnDocRuntime=!0,f=document.body,ut(),document.addEventListener("selectionchange",We),document.addEventListener("mousemove",Je,{passive:!0}),document.addEventListener("click",et,!0),document.documentElement.addEventListener("mouseleave",_),window.addEventListener("scroll",U,{passive:!0}),window.addEventListener("resize",U,{passive:!0}),new ResizeObserver(U).observe(document.body),window.addEventListener("message",t=>{if(t.source!==window.parent)return;let n=t.data;if(!n||n.type!==J)return;let[o]=t.ports;o&&dt(o)}),window.parent.postMessage({type:Z,v:1},"*"))}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",me,{once:!0}):me();})();
