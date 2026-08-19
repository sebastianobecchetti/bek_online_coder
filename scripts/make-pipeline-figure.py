S=[]
def esc(t): return t.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')
def box(x,y,w,h,lines,cls='bx'):
    S.append(f'<rect class="{cls}" x="{x}" y="{y}" width="{w}" height="{h}" rx="3"/>')
    n=len(lines); lh=13; y0=y+h/2-(n-1)*lh/2+4
    for i,l in enumerate(lines):
        S.append(f'<text class="bt" x="{x+w/2}" y="{y0+i*lh:.1f}" text-anchor="middle">{esc(l)}</text>')
def arr(x1,y1,x2,y2,cls='ar'):
    S.append(f'<line class="{cls}" x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" marker-end="url(#a)"/>')
def poly(pts,cls='ar',mark=True):
    d=" ".join(f"{a:.1f},{b:.1f}" for a,b in pts)
    m=' marker-end="url(#a)"' if mark else ''
    S.append(f'<polyline class="{cls}" points="{d}" fill="none"{m}/>')
def lab(x,y,t,anchor='middle',cls='sm'):
    S.append(f'<text class="{cls}" x="{x:.1f}" y="{y:.1f}" text-anchor="{anchor}">{esc(t)}</text>')

BW,BH,GAP,RG = 104,40,26,70
rows=[("positions",[("Z-order",),("2-Opt",),("DPCM",)]),
      ("opacities",[("Sigmoid",),("Uniform","quantizer")]),
      ("rotations",[("Normalize",),("Smallest-3",),("Quantize","and pack")]),
      ("scales",   [("Uniform","quantizer")]),
      ("colors",   [("Residual","VQ"),("Lloyd-Max","quantizer")]),
      ("AC SHs",   [("Residual","VQ"),("Lloyd-Max","quantizer")])]
Y0=110; BUS=128; X0=176
colx=[X0+i*(BW+GAP) for i in range(3)]
rowy=[Y0+i*RG for i in range(6)]
MY=(rowy[0]+rowy[5])/2+BH/2

box(24,MY-BH/2,74,BH,["PLY"])
arr(98,MY,BUS-2,MY)
S.append(f'<line class="ar" x1="{BUS}" y1="{rowy[0]+BH/2}" x2="{BUS}" y2="{rowy[5]+BH/2}"/>')
for r,(name,stages) in enumerate(rows):
    y=rowy[r]
    arr(BUS,y+BH/2,colx[0]-6,y+BH/2)
    lab((BUS+colx[0])/2,y+BH/2-6,name)
    for i,st in enumerate(stages):
        box(colx[i],y,BW,BH,list(st))
        if i: arr(colx[i-1]+BW,y+BH/2,colx[i]-6,y+BH/2)

MX=colx[2]+BW+104
S.append(f'<circle class="bx" cx="{MX}" cy="{MY}" r="15"/>')
lab(MX,MY+5,"↻",cls="bt")
for r,(name,stages) in enumerate(rows):
    y=rowy[r]; ex=colx[len(stages)-1]+BW
    poly([(ex,y+BH/2),(MX-56,y+BH/2),(MX-16,MY)])

CX=MX+104; CW,CH,CG=132,44,14
cands=[("WebP lossless",True,None),("LZMA-based RC",False,None),("Unary-RC",False,"pos. only"),
       ("Packed RC",False,"rot. only"),("Copy",False,None)]
CY=MY-(5*CH+4*CG)/2
cy=[]
for i,(nm,wasm,note) in enumerate(cands):
    y=CY+i*(CH+CG); cy.append(y)
    box(CX,y,CW,CH,[nm]+(["wasm"] if wasm else []),cls='bx wasm' if wasm else 'bx')
    arr(MX+16,MY,CX-6,y+CH/2)
    if note:
        mx=(MX+CX)/2; my=(MY+y+CH/2)/2
        lab(mx+14, (y+CH/2-9) if i==2 else (my-7), note, cls="sm it")

SX=CX+CW+62
box(SX,MY-32,120,64,["Select best","candidate"])
for y in cy: poly([(CX+CW,y+CH/2),(SX-30,y+CH/2),(SX-6,MY)])

ZX=SX+120+50
box(ZX,MY-26,112,52,["Zstandard","wasm"],cls='bx wasm')
arr(SX+120,MY,ZX-6,MY)
box(ZX+13,MY-146,86,40,[".bek"])
arr(ZX+56,MY-26,ZX+56,MY-100)

CBX=colx[1]; CBY=rowy[5]+BH+46
box(CBX,CBY,BW+26,38,["CBOR"])
poly([(colx[0]+12,rowy[5]+BH),(colx[0]+12,CBY+19),(CBX-6,CBY+19)],cls='dsh')
lab((colx[0]+12+CBX)/2+6,CBY+13,"metadata",cls="sm it")
poly([(CBX+BW+26,CBY+19),(ZX+56,CBY+19),(ZX+56,MY+28)],cls='dsh')

W=ZX+112+28; H=CBY+38+26
svg=f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">
<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="#8b949e"/></marker></defs>
<style>
.bx{{fill:none;stroke:#8b949e;stroke-width:1.3}}
.wasm{{stroke:#2f81f7;stroke-width:2}}
.bt{{fill:#8b949e;font-size:11.5px}}
.sm{{fill:#8b949e;font-size:10.5px;opacity:.9}}
.it{{font-style:italic}}
.ar{{stroke:#8b949e;stroke-width:1.1;fill:none}}
.dsh{{stroke:#8b949e;stroke-width:1.1;stroke-dasharray:5 4;fill:none}}
.ti{{fill:#8b949e;font-size:15px;font-weight:600}}
</style>
<text class="ti" x="24" y="30">BEK encoding pipeline — TypeScript port</text>
<text class="sm" x="24" y="50">Same topology as the C++ codec, verified byte-identical on every channel. Blue outline = WebAssembly; everything else is TypeScript.</text>
{chr(10).join(S)}
</svg>'''
open('assets/pipeline-ts.svg','w').write(svg); print(f"{W}x{H}, {len(svg)} byte")
