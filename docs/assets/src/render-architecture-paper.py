"""Render the README diagram. Requires macOS, Swift, CairoSVG and local
Baskerville / Avenir Next fonts. CoreText outlines glyphs before PNG export
to avoid font substitution. No font files are bundled.
"""
from pathlib import Path
from xml.sax.saxutils import escape
import cairosvg
import subprocess
import argparse
import json
ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--lang', choices=['en', 'zh-CN'], default='en')
lang = parser.parse_args().lang
translations = json.loads(Path(__file__).with_name('architecture.zh-CN.json').read_text()) if lang == 'zh-CN' else {}
stem = 'architecture-paper-zh-CN' if lang == 'zh-CN' else 'architecture-paper'
p = []
def add(s): p.append(s)
def text(x,y,s,size=16,color='#68665f',family='Avenir Next',weight='normal',spacing=None):
    if lang == 'zh-CN':
        s = translations[s]
        family = 'Songti SC' if family == 'Baskerville' else 'PingFang SC'
    ls = f' letter-spacing="{spacing}"' if spacing else ''
    add(f'<text x="{x}" y="{y}" font-family="{family}" font-size="{size}" font-weight="{weight}" fill="{color}"{ls}>{escape(s)}</text>')
def line(d,color='#3872a5',dash=False,arrow=True):
    add(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'+(' stroke-dasharray="4 6"' if dash else '')+(' marker-end="url(#arrow)"' if arrow else '')+'/>')
def card(x,y,w,h):
    add(f'<rect x="{x}" y="{y+4}" width="{w}" height="{h}" rx="15" fill="#dedbd3" opacity=".30"/>')
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="15" fill="#fcfbf7" stroke="#dcd8ce"/>')
def rule(x,y,w): line(f'M{x} {y} h{w}', '#e3dfd5', arrow=False)
add('<svg xmlns="http://www.w3.org/2000/svg" width="1520" height="960" viewBox="0 0 1520 960" role="img" aria-labelledby="title desc">')
add('<title id="title">CanvasFlow architecture</title><desc id="desc">The browser canvas sends global and node-local requests to the state machine. The state machine assembles context for planning or execution agents. Each agent submits to a validator; rejected proposals return to the agent. Accepted results return to the state machine, which commits them and sends updates to the canvas. Session storage preserves committed state. Agents call an external model API; data processing nodes are not executed in this demo.</desc>')
add('<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1 L8 5 L2 9" fill="none" stroke="#3872a5" stroke-width="1.3"/></marker><pattern id="paper" width="9" height="9" patternUnits="userSpaceOnUse"><circle cx="1" cy="2" r=".5" fill="#928b7e" opacity=".05"/><circle cx="6" cy="7" r=".4" fill="#fff" opacity=".65"/></pattern></defs>')
add('<rect width="1520" height="960" fill="#f5f3ed"/><rect width="1520" height="960" fill="url(#paper)"/>')
text(70,64,'CANVASFLOW  /  SYSTEM NOTES',12,spacing='2')
text(70,129,'The architecture behind the canvas',45,'#262824','Baskerville')
text(70,168,'A shared surface for intent, action, and the next conversation.',18)
rule(70,207,1380)
text(70,250,'01   BROWSER',12,spacing='1.5'); text(550,250,'02   ORCHESTRATION · NODE.JS',12,spacing='1.5'); text(1030,250,'03   AGENTS & VALIDATION',12,spacing='1.5')
card(70,290,320,410)
text(99,337,'Canvas & conversation',27,'#262824','Baskerville')
text(99,372,'Global input shapes the plan.',16)
text(99,400,'Node input starts a revision.',16)
# Small canvas motif embedded in the browser surface.
line('M135 475 H195 Q205 475 205 485 V508 Q205 518 215 518 H287',arrow=False)
for x,y in [(99,448),(258,492)]:
    add(f'<rect x="{x}" y="{y}" width="66" height="56" rx="9" fill="#fffefa" stroke="#c8d4dc"/>')
    add(f'<circle cx="{x+15}" cy="{y+15}" r="3" fill="#3872a5"/>')
    rule(x+12,y+33,40)
rule(99,584,262)
text(99,618,'Progress, results, questions',16,'#343630')
text(99,645,'stay close to the work.',16,'#343630')
card(550,290,310,330)
text(579,337,'State machine',29,'#262824','Baskerville')
text(579,378,'Assemble context',17,'#343630')
text(579,408,'Coordinate turns & cancellation',15)
rule(579,435,252)
text(579,468,'Build in dependency waves',16)
text(579,498,'Review revisions as a whole',16)
rule(579,525,252)
text(579,566,'Commit accepted changes',17,'#343630')
text(579,593,'Publish updates to the canvas',15)
# Agent cards include their own validation boundary.
for y,title,sub,gate in [(290,'Plan Agent','Shape a complete plan','Plan gate'),(480,'Execution Agent','Build steps · revise the workflow','Canvas / revision gate')]:
    card(1030,y,340,150)
    text(1058,y+39,title,27,'#262824','Baskerville')
    text(1058,y+69,sub,15)
    rule(1058,y+88,284)
    add(f'<circle cx="1062" cy="{y+118}" r="3" fill="#3872a5"/>')
    text(1075,y+124,gate,16,'#343630')
    text(1312,y+123,'CODE',10,spacing='.7')
    # Gate rejection returns only to its own agent.
    line(f'M1370 {y+118} H1400 Q1412 {y+118} 1412 {y+106} V{y+41} Q1412 {y+29} 1400 {y+29} H1373',dash=True)
text(1390,463,'retry',12)
text(1390,653,'retry',12)
# Requests and updates remain separate, directional paths.
line('M390 365 H550'); text(411,350,'requests',14)
line('M550 578 H475 Q459 578 459 594 V650 Q459 666 443 666 H392'); text(402,694,'updates',14)
line('M860 320 H1030'); text(884,307,'conversation',13)
line('M1030 408 H860'); text(884,396,'accepted plan',13)
line('M860 497 H1030'); text(876,481,'task context',13)
line('M1030 598 H860'); text(880,585,'accepted result',13)
# Local persistence.
card(550,727,310,99)
text(579,766,'Session store',24,'#262824','Baskerville')
text(579,797,'Plan · canvas · conversation · history',14)
line('M705 620 V727'); add('<path d="M701 627 L705 621 L709 627" fill="none" stroke="#3872a5" stroke-width="1.4"/>'); text(722,680,'save / restore',13)
text(1030,687,'WHOLE-WORKFLOW REVISION',11,spacing='1.2')
text(1030,717,'Plan + canvas + request + relevant history',14)
text(1030,743,'Necessary changes, one atomic commit.',14)
text(1030,794,'Both agents use an external Model API.',14)
text(1030,818,'Execution selects from the node catalog.',14)
rule(70,869,1380)
text(70,909,'Models propose. Code validates and commits. You direct the next move.',17,'#343630','Baskerville')
text(70,937,'Current demo: workflow generation and revision. Real data processing awaits executable node integrations.',13)
add('</svg>')
svg = '\n'.join(p)
(ROOT/f'{stem}.svg').write_text(svg)
subprocess.run(['swift', str(Path(__file__).with_name('outline-diagram-type.swift')), str(ROOT/f'{stem}.svg'), str(ROOT/f'{stem}-outlined.svg')], check=True)
cairosvg.svg2png(url=str(ROOT/f'{stem}-outlined.svg'),write_to=str(ROOT/f'{stem}.png'),scale=1.5)
print(f'Rendered {stem}.svg and {stem}.png')
