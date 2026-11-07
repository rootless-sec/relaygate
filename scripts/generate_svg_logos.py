import os
from PIL import Image

def generate_svg(img_path, out_svg, threshold=120):
    im = Image.open(img_path)
    w, h = im.size
    grid = [[0]*(w+2) for _ in range(h+2)]
    for y in range(h):
        for x in range(w):
            p = im.getpixel((x, y))
            if p[3] >= threshold:
                grid[y+1][x+1] = 1

    segments = []
    for y in range(h+1):
        for x in range(w+1):
            tl = grid[y][x]
            tr = grid[y][x+1]
            br = grid[y+1][x+1]
            bl = grid[y+1][x]
            case = (tl << 3) | (tr << 2) | (br << 1) | bl
            top = (x - 0.5, y - 1.0)
            right = (x, y - 0.5)
            bottom = (x - 0.5, y)
            left = (x - 1.0, y - 0.5)

            if case == 1: segments.append((bottom, left))
            elif case == 2: segments.append((right, bottom))
            elif case == 3: segments.append((right, left))
            elif case == 4: segments.append((top, right))
            elif case == 5:
                segments.append((top, right))
                segments.append((bottom, left))
            elif case == 6: segments.append((top, bottom))
            elif case == 7: segments.append((top, left))
            elif case == 8: segments.append((left, top))
            elif case == 9: segments.append((bottom, top))
            elif case == 10:
                segments.append((left, top))
                segments.append((right, bottom))
            elif case == 11: segments.append((right, top))
            elif case == 12: segments.append((left, right))
            elif case == 13: segments.append((bottom, right))
            elif case == 14: segments.append((left, bottom))

    from_map = {}
    for p1, p2 in segments:
        from_map.setdefault(p1, []).append(p2)

    polygons = []
    for start in list(from_map.keys()):
        while from_map.get(start):
            p2 = from_map[start].pop()
            poly = [start]
            curr = p2
            while curr != start and curr in from_map and from_map[curr]:
                poly.append(curr)
                curr = from_map[curr].pop()
            if curr == start:
                polygons.append(poly)

    def simplify(poly):
        if len(poly) < 3: return poly
        res = [poly[0]]
        for i in range(1, len(poly)):
            prev = res[-1]
            curr = poly[i]
            nxt = poly[(i+1)%len(poly)]
            dx1, dy1 = curr[0] - prev[0], curr[1] - prev[1]
            dx2, dy2 = nxt[0] - curr[0], nxt[1] - curr[1]
            if abs(dx1*dy2 - dy1*dx2) > 1e-4:
                res.append(curr)
        return res

    simplified = [simplify(p) for p in polygons if len(p) >= 3]

    path_data = []
    for poly in simplified:
        pts = [f"{x:.1f} {y:.1f}" for x, y in poly]
        path_data.append("M " + pts[0] + " L " + " ".join(pts[1:]) + " Z")

    d = " ".join(path_data)
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" fill="currentColor" fill-rule="evenodd">\n  <path d="{d}" />\n</svg>\n'
    os.makedirs(os.path.dirname(out_svg), exist_ok=True)
    with open(out_svg, 'w', encoding='utf-8') as f:
        f.write(svg)
    print(f"Generated {out_svg} ({len(svg)} bytes, {len(simplified)} polygons)")
    return d, w, h

if __name__ == '__main__':
    icon_src = r'C:\Users\ASUS\.gemini\antigravity\scratch\relaygate\ui\public\relaygate-icon.png'
    logo_src = r'C:\Users\ASUS\.gemini\antigravity\brain\0f626320-fda7-4886-b746-3f6e3d439983\.user_uploaded\media_1794066339573_e1a7d1d6.png'
    
    icon_dst = r'C:\Users\ASUS\.gemini\antigravity\scratch\relaygate\ui\public\relaygate-icon.svg'
    logo_dst = r'C:\Users\ASUS\.gemini\antigravity\scratch\relaygate\ui\public\relaygate-logo.svg'
    
    icon_d, iw, ih = generate_svg(icon_src, icon_dst)
    logo_d, lw, lh = generate_svg(logo_src, logo_dst)
    
    # Also write a React component file ui/src/components/RelayGateLogo.tsx
    react_code = f'''import React from 'react';

export interface RelayGateIconProps extends React.SVGProps<SVGSVGElement> {{
  size?: number | string;
}}

export interface RelayGateLogoProps extends React.SVGProps<SVGSVGElement> {{
  height?: number | string;
  width?: number | string;
}}

export const RELAYGATE_ICON_PATH = "{icon_d}";
export const RELAYGATE_LOGO_PATH = "{logo_d}";

export const RelayGateIcon: React.FC<RelayGateIconProps> = ({{
  size = 24,
  className = '',
  ...props
}}) => {{
  return (
    <svg
      width={{size}}
      height={{size}}
      viewBox="0 0 {iw} {ih}"
      fill="currentColor"
      fillRule="evenodd"
      className={{className}}
      aria-hidden="true"
      {{...props}}
    >
      <path d={{RELAYGATE_ICON_PATH}} />
    </svg>
  );
}};

export const RelayGateLogo: React.FC<RelayGateLogoProps> = ({{
  height = 24,
  width,
  className = '',
  ...props
}}) => {{
  return (
    <svg
      height={{height}}
      width={{width}}
      viewBox="0 0 {lw} {lh}"
      fill="currentColor"
      fillRule="evenodd"
      className={{className}}
      aria-label="RelayGate"
      role="img"
      {{...props}}
    >
      <path d={{RELAYGATE_LOGO_PATH}} />
    </svg>
  );
}};
'''
    with open(r'C:\Users\ASUS\.gemini\antigravity\scratch\relaygate\ui\src\components\RelayGateLogo.tsx', 'w', encoding='utf-8') as f:
        f.write(react_code)
    print("Wrote ui/src/components/RelayGateLogo.tsx")
