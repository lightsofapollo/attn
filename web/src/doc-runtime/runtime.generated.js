"use strict";(()=>{var q="attn:doc:hello",U="attn:shell:init";var et=new TextEncoder;var ve=new TextEncoder;function h(e){return ve.encode(e).length}function y(e,t,n){let o=0,r=0,s=0;for(let i of e){let a=h(i);if(r+1>t||o+a>n)break;o+=a,r+=1,s+=i.length}return s===e.length?e:e.slice(0,s)}function Z(e){return e.ownerDocument.createTreeWalker(e,NodeFilter.SHOW_TEXT)}function x(e,t,n){if(t.nodeType!==Node.TEXT_NODE){let i=e.ownerDocument.createRange();return i.selectNodeContents(e),i.setEnd(t,n),h(i.toString())}let o=0,r=Z(e),s=r.nextNode();for(;s;){if(s===t)return o+h((s.nodeValue??"").slice(0,n));o+=h(s.nodeValue??""),s=r.nextNode()}return o}function z(e,t){let n=0,o=Z(e),r=o.nextNode(),s=null;for(;r;){let i=r.nodeValue??"",a=h(i);if(n+a>=t){let c=0,u=0;for(let l of i){if(n+c>=t)return{node:r,offset:u};c+=h(l),u+=l.length}return{node:r,offset:i.length}}n+=a,s={node:r,offset:i.length},r=o.nextNode()}return s}function N(e,t,n){let o=z(e,t),r=z(e,n);if(!o||!r)return null;let s=e.ownerDocument.createRange();try{s.setStart(o.node,o.offset),s.setEnd(r.node,r.offset)}catch{return null}return s}function M(e){return e.textContent??""}var Se=new Set(["TD","TH"]),ye=e=>Se.has(e.tagName);function we(e){let t=e.parentElement;return t?Array.from(t.children).filter(n=>n.tagName==="TR").indexOf(e)+1:1}function L(e){let t=e.parentElement;if(!t)return"";let n=Array.from(t.children).filter(o=>o.tagName===e.tagName);return n.length<=1?"":`:nth-of-type(${n.indexOf(e)+1})`}function J(e){return e.length===0||e.length>64||!/^[A-Za-z][\w-]*$/.test(e)||/^(react|radix|mui|headless|aria)[-_]/i.test(e)?!1:!/[0-9a-f]{8,}/i.test(e)}function ee(e){if(typeof e.className!="string")return"";let t=e.className.trim().split(/\s+/).filter(Boolean);for(let n of t)if(/^[\w-]+$/.test(n)&&n.length<=40&&!/[0-9a-f]{6,}/i.test(n))return`.${CSS.escape(n)}`;return""}function te(e){let t=e.parentElement,n=e.closest("table"),o=[n?T(n):"table"];return t&&t!==n&&o.push(t.tagName.toLowerCase()),o.push(`tr:nth-of-type(${we(e)})`),o.join(" > ")}function Ce(e){let t=e.closest("tr");if(!t)return e.tagName.toLowerCase();let n=Array.from(t.children).filter(o=>o.tagName===e.tagName);return`${te(t)} > ${e.tagName.toLowerCase()}:nth-of-type(${n.indexOf(e)+1})`}function T(e){return e.id&&J(e.id)?`#${CSS.escape(e.id)}`:e.tagName==="TR"?te(e):ye(e)?Ce(e):`${e.tagName.toLowerCase()}${ee(e)}${L(e)}`}function ne(e){let t=[],n=c=>{c&&!t.includes(c)&&t.length<8&&t.push(c)},o=[],r=e;for(;r&&r.tagName!=="BODY"&&o.length<12;)o.unshift(`${r.tagName.toLowerCase()}${L(r)}`),r=r.parentElement;o.length>0&&n(o.join(" > "));let s=e.parentElement,i=[`${e.tagName.toLowerCase()}${L(e)}`];for(;s&&s.tagName!=="BODY"&&i.length<6;){if(s.id&&J(s.id)){n(`#${CSS.escape(s.id)} ${i.join(" > ")}`);break}i.unshift(`${s.tagName.toLowerCase()}${L(s)}`),s=s.parentElement}let a=ee(e);return a&&n(`${e.tagName.toLowerCase()}${a}`),t.filter(c=>c!==T(e))}var Ae={TR:"row",TD:"cell",TH:"columnheader",TABLE:"table",LI:"listitem",UL:"list",OL:"list",P:"paragraph",BLOCKQUOTE:"blockquote",FIGURE:"figure",IMG:"img",H1:"heading",H2:"heading",H3:"heading",H4:"heading"};function oe(e,t){let n=[],o=e;for(;o&&o.tagName!=="BODY"&&n.length<8;)n.unshift(o.tagName.toLowerCase()),o=o.parentElement;let r=e.getAttribute("role")??Ae[e.tagName],s={tagName:e.tagName.toLowerCase(),scopePreview:y(t,200,256),domPath:n};return r&&(s.role=r),s}function Te(e,t){let n=t.startContainer.nodeType===Node.ELEMENT_NODE?t.startContainer:t.startContainer.parentElement,o=t.endContainer.nodeType===Node.ELEMENT_NODE?t.endContainer:t.endContainer.parentElement;return!n||!o||n===o?null:{startSelector:T(n),startOffset:x(n,t.startContainer,t.startOffset),endSelector:T(o),endOffset:x(o,t.endContainer,t.endOffset)}}function re(e,t){let n=t.commonAncestorContainer.nodeType===Node.ELEMENT_NODE?t.commonAncestorContainer:t.commonAncestorContainer.parentElement??e,o=x(e,t.startContainer,t.startOffset),r=x(e,t.endContainer,t.endOffset),s={v:1,target:"text_range",cssSelector:T(n),fallbackSelectors:ne(n),textPosition:{start:o,end:r},context:oe(n,y(t.toString(),120,256))},i=Te(e,t);return i&&(s.range=i),s}function I(e,t,n){let o=e.ownerDocument.createRange();return o.selectNodeContents(t),{v:1,target:"element",cssSelector:T(t),fallbackSelectors:ne(t),textPosition:{start:x(e,o.startContainer,o.startOffset),end:x(e,o.endContainer,o.endOffset)},context:oe(t,n)}}var W={range:null,element:null,status:"stale",confidence:0};function Re(e){return e.replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/[–—]/g,"-").replace(/\s+/g," ").trim()}function Oe(e){let t=[],n=[],o=[],r=-1;for(let s=0;s<e.length;s+=1){let i=e[s];if(/\s/.test(i)){r===-1&&(r=s);continue}i==="\u2018"||i==="\u2019"?i="'":i==="\u201C"||i==="\u201D"?i='"':(i==="\u2013"||i==="\u2014")&&(i="-"),r!==-1&&t.length>0&&(t.push(" "),n.push(r),o.push(s)),r=-1,t.push(i),n.push(s),o.push(s+1)}return{normalized:t.join(""),starts:n,ends:o}}function R(e,t){try{return e.querySelector(t)}catch{return null}}function K(e,t){let n=[];if(t.length===0)return n;let o=0;for(;;){let r=e.indexOf(t,o);if(r===-1||(n.push(r),o=r+1,n.length>64))return n}}function Q(e,t){let n=Math.min(e.length,t.length),o=0;for(;o<n&&e[o]===t[o];)o+=1;return o}function _e(e,t,n,o,r){let s=t.map(a=>{let c=e.slice(Math.max(0,a-o.length),a),u=e.slice(a+n,a+n+r.length),l=Q([...c].reverse().join(""),[...o].reverse().join(""))+Q(u,r);return{at:a,score:l}});s.sort((a,c)=>c.score-a.score);let i=s.length>1&&s[0].score===s[1].score;return{index:s[0].at,ambiguous:i}}function se(e,t){let{anchor:n,quote:o,prefix:r="",suffix:s=""}=t;if(n.target==="element"){let c=R(e,n.cssSelector)??(n.fallbackSelectors??[]).reduce((A,S)=>A??R(e,S),null);if(!c)return W;let u=e.ownerDocument.createRange();u.selectNodeContents(c);let l=R(e,n.cssSelector)===c;return{range:u,element:c,status:l?"exact":"remapped",confidence:l?1:.7}}let i=M(e);if(o&&n.textPosition){let{start:c,end:u}=n.textPosition,l=N(e,c,u);if(l&&l.toString()===o)return{range:l,element:null,status:"exact",confidence:1}}if(o&&o.length>0){let c=K(i,o);if(c.length>0){let{index:u,ambiguous:l}=_e(i,c,o.length,r,s),A=h(i.slice(0,u)),S=N(e,A,A+h(o));if(S)return{range:S,element:null,status:l?"ambiguous":"remapped",confidence:l?.4:c.length===1?.9:.75}}}if(o){let c=Re(o),{normalized:u,starts:l,ends:A}=Oe(i);if(c.length>0){let S=K(u,c);if(S.length===1){let G=S[0],F=l[G],V=A[G+c.length-1];if(F!==void 0&&V!==void 0){let Ee=h(i.slice(0,F)),be=h(i.slice(0,V)),j=N(e,Ee,be);if(j)return{range:j,element:null,status:"remapped",confidence:.6}}}}}let a=R(e,n.cssSelector)??(n.fallbackSelectors??[]).reduce((c,u)=>c??R(e,u),null);if(a){let c=e.ownerDocument.createRange();return c.selectNodeContents(a),{range:c,element:a,status:"remapped",confidence:.35}}return W}var ie=`
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

/* Left-margin pin revealed on block hover. */
.attn-gutter-pin {
  position: absolute;
  left: 8px;
  pointer-events: auto;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--attn-border);
  border-radius: 999px;
  background: var(--attn-surface);
  color: var(--attn-ink);
  cursor: pointer;
  opacity: 0;
  transition: opacity 120ms ease;
  box-shadow: var(--attn-shadow);
}
.attn-gutter-pin.is-visible { opacity: 1; }
.attn-gutter-pin::before {
  content: "";
  position: absolute;
  inset: 6px;
  border: 1.5px solid currentColor;
  border-radius: 3px 3px 3px 0;
  opacity: 0.7;
}
.attn-gutter-pin.has-comments {
  background: var(--attn-comment-accent);
}
.attn-gutter-pin.has-comments::after {
  content: attr(data-count);
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 14px;
  height: 14px;
  border-radius: 999px;
  background: var(--attn-element-accent);
  color: oklch(0.98 0.005 78);
  font-size: 9px;
  font-weight: 700;
  line-height: 14px;
}

/* Scope breadcrumb: drill into a cell or out to the whole table. */
.attn-flyout {
  position: absolute;
  top: 0;
  left: 30px;
  display: none;
  flex-direction: column;
  min-width: 220px;
  padding: 4px;
  border: 1px solid var(--attn-border);
  border-radius: 8px;
  background: var(--attn-surface);
  box-shadow: var(--attn-shadow);
}
.attn-flyout.is-visible { display: flex; }

.attn-scope-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--attn-ink);
  text-align: left;
  cursor: pointer;
  font-size: 12px;
}
.attn-scope-item:hover { background: color-mix(in oklch, var(--attn-ink) 8%, transparent); }
.attn-scope-title { font-weight: 600; white-space: nowrap; }
.attn-scope-preview {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.65;
}
.attn-scope-count {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--attn-element-accent);
  color: oklch(0.98 0.005 78);
  font-size: 10px;
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
  .attn-pin,
  .attn-gutter-pin { transition: none; }
}
`;var Le="attn-text",ke="attn-text-active",O=64,k=null,d,v,f,E,p,g=new Map,_=new Map,ae=[],w=null,Ne=0;function b(e){k?.postMessage(e)}function Me(e){return{x:e.x,y:e.y,width:e.width,height:e.height}}function C(e){return e?Array.from(e.getClientRects()).filter(n=>n.width>0&&n.height>0).slice(0,128).map(Me):[]}var Ie=new Set(["TD","TH","TR","LI","FIGURE","PRE","TABLE","BLOCKQUOTE","H1","H2","H3","H4","P","IMG","FIGCAPTION","UL","OL"]),X=e=>e.tagName==="TD"||e.tagName==="TH";function Pe(e){let t=[],n=e;for(;n&&n!==d&&t.length<12;)Ie.has(n.tagName)&&t.push(n),n=n.parentElement;return t}function le(e){return e.find(t=>!X(t))??e[0]}function ue(e){let t=e.parentElement;return t?Array.from(t.children).filter(n=>n.tagName==="TR").indexOf(e)+1:1}function de(e){return X(e)?"cell":e.tagName==="TR"?e.closest("thead")?"header row":`row ${ue(e)}`:e.tagName==="LI"?"list item":e.tagName==="PRE"?"code block":/^H[1-6]$/.test(e.tagName)?"heading":e.tagName.toLowerCase()}function fe(e){if(e.tagName==="TR"){let n=Array.from(e.querySelectorAll("th,td")).map(s=>s.textContent?.trim()??""),o=e.closest("thead")?"header row":`row ${ue(e)}`,r=[n[0],n[1]].filter(Boolean).join(" \xB7 ");return r?`${o} \xB7 ${r}`:o}if(X(e)){let n=e.closest("tr"),o=n?Array.from(n.children).indexOf(e):-1,s=e.closest("table")?.querySelector("thead tr")?.children[o]?.textContent?.trim(),i=e.textContent?.trim()??"";return s?`${s}: ${i}`:i}let t=e.textContent?.trim()??"";return t?t.slice(0,80):null}function pe(e){let t=0;for(let n of g.values())n.element===e&&(t+=1);return t}function De(e){let t=d.ownerDocument.createRange();t.selectNodeContents(d),t.setEnd(e.startContainer,e.startOffset);let n=d.ownerDocument.createRange();n.selectNodeContents(d),n.setStart(e.endContainer,e.endOffset);let o=t.toString(),r=[...o.slice(-O*2)].slice(-O),s=[...n.toString().slice(0,O*2)].slice(0,O);if(r.length>0&&o.length>O*2){let i=r[0].charCodeAt(0);i>=56320&&i<=57343&&r.shift()}return{prefix:r.join(""),suffix:s.join("")}}function me(e){let t=x(d,e.startContainer,e.startOffset),n=x(d,e.endContainer,e.endOffset),o=e.toString(),{prefix:r,suffix:s}=De(e);return{html:re(d,e),quote:y(o,4e3,4096),prefix:r,suffix:s,textStart:t,textEnd:n}}function He(e){let t=fe(e)??de(e),n=I(d,e,t),o=y((e.textContent??"").trim(),4e3,4096);return{html:n,quote:o,prefix:"",suffix:"",textStart:n.textPosition?.start??0,textEnd:n.textPosition?.end??0}}function Be(){let e=window.getSelection();return!!e&&!e.isCollapsed&&e.rangeCount>0}function Xe(){let e=window.getSelection();if(!e||e.isCollapsed||e.rangeCount===0){w=null,he(),b({type:"selectionCleared",v:1});return}let t=e.getRangeAt(0);if(t.toString().trim().length===0)return;w=t.cloneRange();let n=C(t),o=n[n.length-1];$e(o),b({type:"selection",v:1,proposal:me(t),rects:n,caret:o??{x:0,y:0,width:0,height:0}})}function $e(e){e&&(p.style.left=`${e.x+e.width}px`,p.style.top=`${e.y+e.height+8}px`,p.classList.add("is-visible"))}function he(){p.classList.remove("is-visible")}function Ye(e){if(Be()){B();return}let t=e.target;if(!(t instanceof Element))return;let n=Pe(t),o=le(n);if(!o){B();return}ae=n,Ge(o),Fe(n)}function Ge(e){let t=e.getBoundingClientRect();f.style.top=`${t.top+window.scrollY+t.height/2-12}px`,f.classList.add("is-visible");let n=pe(e);f.dataset.count=n>0?String(n):"",f.classList.toggle("has-comments",n>0)}function B(){f.classList.remove("is-visible"),E.classList.remove("is-visible")}function Fe(e){_.clear();let t=e.slice(0,8).map(n=>{let o=`scope-${Ne+=1}`;_.set(o,n);let r=fe(n);return{scopeId:o,title:de(n),preview:r===null?null:y(r,200,256),selector:I(d,n,"").cssSelector,commentCount:pe(n),rects:C(n)}});b({type:"scopeHover",v:1,chain:t}),Ve(t)}function Ve(e){E.textContent="";for(let t of e){let n=document.createElement("button");n.type="button",n.className="attn-scope-item";let o=document.createElement("span");if(o.className="attn-scope-title",o.textContent=t.title,n.appendChild(o),t.preview){let r=document.createElement("span");r.className="attn-scope-preview",r.textContent=t.preview,n.appendChild(r)}if(t.commentCount>0){let r=document.createElement("span");r.className="attn-scope-count",r.textContent=String(t.commentCount),n.appendChild(r)}n.addEventListener("mouseenter",()=>ge(_.get(t.scopeId))),n.addEventListener("click",r=>{r.preventDefault(),$(t.scopeId)}),E.appendChild(n)}}var P=null;function ge(e){if(P?.remove(),P=null,!e)return;let t=e.getBoundingClientRect(),n=document.createElement("div");n.className="attn-outline",n.style.cssText=`top:${t.top+window.scrollY}px;left:${t.left+window.scrollX}px;width:${t.width}px;height:${t.height}px`,v.appendChild(n),P=n}function $(e){let t=_.get(e);t&&(B(),ge(void 0),b({type:"scopePicked",v:1,proposal:He(t),rects:C(t)}))}function Y(){let e=CSS.highlights;if(!e||typeof Highlight>"u")return;let t=[],n=[];for(let o of g.values())o.spec.html.target!=="text_range"||!o.range||(o.spec.state==="active"?n:t).push(o.range);e.set(Le,new Highlight(...t)),e.set(ke,new Highlight(...n))}function xe(e){if(e.overlay?.remove(),e.pin?.remove(),e.overlay=null,e.pin=null,e.spec.html.target!=="element"||!e.element)return;let t=e.element.getBoundingClientRect(),n=t.top+window.scrollY,o=t.left+window.scrollX,r=document.createElement("div");r.className="attn-overlay",r.dataset.state=e.spec.state,r.style.cssText=`top:${n}px;left:${o}px;width:${t.width}px;height:${t.height}px`,v.appendChild(r),e.overlay=r;let s=document.createElement("button");s.type="button",s.className="attn-pin",s.dataset.state=e.spec.state,s.textContent=e.spec.label??"1",s.style.cssText=`top:${n-10}px;left:${o-14}px`,s.addEventListener("click",i=>{i.stopPropagation(),b({type:"anchorActivated",v:1,anchorId:e.spec.anchorId})}),v.appendChild(s),e.pin=s}function je(e){let t=se(d,{anchor:e.html,quote:e.quote,prefix:e.prefix,suffix:e.suffix}),n={spec:e,range:t.range,element:t.element,status:t.status,confidence:t.confidence,overlay:null,pin:null};return xe(n),n}function qe(e){for(let t of g.values())t.overlay?.remove(),t.pin?.remove();g.clear();for(let t of e)g.set(t.anchorId,je(t));Y(),Ue()}function Ue(){let e=[];for(let t of g.values())e.push({anchorId:t.spec.anchorId,status:t.status,confidence:t.confidence,rects:C(t.range??t.element)});b({type:"anchorsResolved",v:1,results:e})}function ze(){let e=[];for(let t of g.values())e.push({anchorId:t.spec.anchorId,rects:C(t.range??t.element)});b({type:"geometry",v:1,results:e,scrollTop:window.scrollY})}function We(e,t){let n=g.get(e);n&&(n.spec={...n.spec,state:t},n.overlay&&(n.overlay.dataset.state=t),n.pin&&(n.pin.dataset.state=t),Y())}function Ke(e,t){let n=g.get(e);if(!n||!t)return;(n.element??n.range?.startContainer.parentElement)?.scrollIntoView({behavior:"smooth",block:"center"})}var D=0;function H(){D||(D=requestAnimationFrame(()=>{D=0;for(let e of g.values())xe(e);Y(),ze()}))}function Qe(e){switch(e.type){case"renderAnchors":qe(e.anchors);break;case"setAnchorState":We(e.anchorId,e.state);break;case"focusAnchor":Ke(e.anchorId,e.scrollIntoView);break;case"pickScope":$(e.scopeId);break;case"dismissSelection":window.getSelection()?.removeAllRanges(),w=null,he();break;case"theme":d.dataset.attnTheme=e.mode;break;default:break}}function Ze(){let e=document.createElement("style");e.textContent=ie,document.head.appendChild(e),v=document.createElement("div"),v.className="attn-layer",document.body.appendChild(v),f=document.createElement("button"),f.type="button",f.className="attn-gutter-pin",f.setAttribute("aria-label","Comment on this block"),f.addEventListener("mouseenter",()=>E.classList.add("is-visible")),f.addEventListener("click",t=>{t.preventDefault();let n=le(ae);if(!n)return;let o=[..._.entries()].find(([,r])=>r===n);o&&$(o[0])}),v.appendChild(f),E=document.createElement("div"),E.className="attn-flyout",E.addEventListener("mouseleave",()=>E.classList.remove("is-visible")),f.appendChild(E),p=document.createElement("button"),p.type="button",p.className="attn-pill",p.textContent="Comment",p.addEventListener("mousedown",t=>t.preventDefault()),p.addEventListener("click",()=>{w&&b({type:"selection",v:1,proposal:me(w),rects:C(w),caret:C(w).slice(-1)[0]??{x:0,y:0,width:0,height:0}})}),v.appendChild(p)}function Je(e){k=e,k.onmessage=t=>{let n=t.data;!n||typeof n!="object"||typeof n.type!="string"||n.v===1&&Qe(n)},k.start(),b({type:"ready",v:1,textLength:M(d).length,title:y(document.title,200,512)})}function ce(){let e=window;e.__attnDocRuntime||(e.__attnDocRuntime=!0,d=document.body,Ze(),document.addEventListener("selectionchange",Xe),document.addEventListener("mousemove",Ye,{passive:!0}),window.addEventListener("scroll",H,{passive:!0}),window.addEventListener("resize",H,{passive:!0}),new ResizeObserver(H).observe(document.body),window.addEventListener("message",t=>{if(t.source!==window.parent)return;let n=t.data;if(!n||n.type!==U)return;let[o]=t.ports;o&&Je(o)}),window.parent.postMessage({type:q,v:1},"*"))}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",ce,{once:!0}):ce();})();
