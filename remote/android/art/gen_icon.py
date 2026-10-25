#!/usr/bin/env python3
"""VOID Portal logo: one geometry, written as the SVG master and the Android icon layers, once per theme.

A portal ring with two galaxy arms that spiral out from a bright spark at the centre, past the ring,
each with a soft glow. The same spiral is drawn (and animated) in Kotlin by PortalLogo.kt.
Themes come from art/themes.json (generated from the desktop's themes by gen_themes.mjs); each gets a
launcher icon, and the manifest gets one <activity-alias> per theme so the app can switch its icon.

Run from remote/android:  python3 art/gen_icon.py
"""
import json
import math
import os
import re

C = 54.0
RING_R, RING_W = 28.5, 4.6
THETA_MAX = 1.7 * math.pi
R0, R_GROW = 2.5, 36.0


def arm_points(phase, n=64, length=1.0, width_scale=1.0, t0=0.0):
    """Outline of one tapered arm (or the part t0..length of it): thin at the centre, widest early, a fine tail."""
    pts = []
    for i in range(n + 1):
        t = t0 + i / n * (length - t0)
        th = t * THETA_MAX
        r = R0 + R_GROW * t ** 1.25
        pts.append((C + r * math.cos(th + phase), C + r * math.sin(th + phase), t))
    left, right = [], []
    for i, (x, y, t) in enumerate(pts):
        x2, y2, _ = pts[min(i + 1, n)] if i < n else pts[i]
        x1, y1, _ = pts[max(i - 1, 0)]
        dx, dy = x2 - x1, y2 - y1
        d = math.hypot(dx, dy) or 1
        nx, ny = -dy / d, dx / d
        w = (0.3 + 2.5 * math.sin(math.pi * min(t, 0.999) ** 0.55)) * width_scale / 2
        left.append((x + nx * w, y + ny * w))
        right.append((x - nx * w, y - ny * w))
    poly = left + right[::-1]
    return "M" + " L".join(f"{x:.2f},{y:.2f}" for x, y in poly) + " Z", pts[-1][:2]


def circle(cx, cy, r):
    return f"M{cx - r:g},{cy} a{r:g},{r:g} 0 1,0 {2 * r:g},0 a{r:g},{r:g} 0 1,0 {-2 * r:g},0"


S = 11.0 / 9.5  # spark scale
SPARK = (
    f"M54,{54 - 9.5 * S:.2f} C{54 + 0.9 * S:.2f},{54 - 3.4 * S:.2f} {54 + 3.4 * S:.2f},{54 - 0.9 * S:.2f} {54 + 9.5 * S:.2f},54 "
    f"C{54 + 3.4 * S:.2f},{54 + 0.9 * S:.2f} {54 + 0.9 * S:.2f},{54 + 3.4 * S:.2f} 54,{54 + 9.5 * S:.2f} "
    f"C{54 - 0.9 * S:.2f},{54 + 3.4 * S:.2f} {54 - 3.4 * S:.2f},{54 + 0.9 * S:.2f} {54 - 9.5 * S:.2f},54 "
    f"C{54 - 3.4 * S:.2f},{54 - 0.9 * S:.2f} {54 - 0.9 * S:.2f},{54 - 3.4 * S:.2f} 54,{54 - 9.5 * S:.2f} Z"
)
STARS = [(22, 26, 0.9, 0.8), (86, 20, 0.7, 0.6), (90, 72, 1.0, 0.7), (16, 82, 0.7, 0.5), (76, 92, 0.6, 0.6), (36, 13, 0.5, 0.5)]
PHASES = [-math.pi / 2, math.pi / 2]


def vd_lin(x1, y1, x2, y2, stops):
    items = "".join(f'<item android:offset="{o}" android:color="{c}"/>' for o, c in stops)
    return f'<gradient android:type="linear" android:startX="{x1:.2f}" android:startY="{y1:.2f}" android:endX="{x2:.2f}" android:endY="{y2:.2f}">{items}</gradient>'


def vd_rad(cx, cy, r, stops):
    items = "".join(f'<item android:offset="{o}" android:color="{c}"/>' for o, c in stops)
    return f'<gradient android:type="radial" android:centerX="{cx}" android:centerY="{cy}" android:gradientRadius="{r}">{items}</gradient>'


def argb(hex_rgb, a):
    return f"#{int(a * 255):02X}{hex_rgb[1:]}"


def mix(a, b, f):
    pa = [int(a[i:i + 2], 16) for i in (1, 3, 5)]
    pb = [int(b[i:i + 2], 16) for i in (1, 3, 5)]
    return "#" + "".join(f"{round(x + (y - x) * f):02X}" for x, y in zip(pa, pb))


SEGMENTS = 14


def palette(theme):
    """Icon colours from a desktop theme: ring and arms from its two accents, a dark portal core, and
    deep space (or, for a light theme, a pale sky) behind it."""
    c = theme["colors"]
    light = theme["mode"] == "light"
    a, a2 = c["accent"].upper(), c["accent2"].upper()
    return {
        "ring": [(0, a), (0.55, mix(a, a2, 0.45)), (1, a2)],
        "arms": [a2, mix(a, "#FFFFFF", 0.25)],
        "hot": mix("#FFFFFF", a2, 0.05),
        "bg": (mix(c["panelAlt"], a, 0.08), c["bg"].upper()) if light else (mix(c["bg"], a, 0.12), mix(c["bg"], "#000000", 0.35)),
        "nebula": (mix(c["bg"], a, 0.35), 0.45) if light else (mix(c["bg"], a, 0.45), 0.85),
        "star": (a, 0.45) if light else ("#FFFFFF", 1.0),
        "core": [(0, mix("#0B0820", a, 0.22)), (0.6, "#0B0820"), (1, "#05040C")],
        "glow": a2,
        "spark_end": mix("#FFFFFF", a2, 0.35),
    }


def arm_segments(phase, color, hot="#F2FDFF"):
    """The arm in short overlapping pieces, coloured along its length: white-hot core, arm colour, fading tail."""
    out = []
    for k in range(SEGMENTS):
        t0, t1 = k / SEGMENTS, min(1.0, (k + 1.35) / SEGMENTS)
        tm = (t0 + t1) / 2
        c = mix(hot, color, min(1.0, tm / 0.22))
        alpha = 1.0 if tm < 0.55 else 1.0 - 0.5 * (tm - 0.55) / 0.45
        d, _ = arm_points(phase, n=10, length=t1, t0=t0)
        out.append((d, c, alpha))
    return out


HEAD = ('<?xml version="1.0" encoding="utf-8"?>\n<vector xmlns:android="http://schemas.android.com/apk/res/android" '
        'xmlns:aapt="http://schemas.android.com/aapt" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">\n')
def opaque(stops):
    return [(o, argb(c, 1)) for o, c in stops]


def background_vd(P):
    out = HEAD
    top, bottom = P["bg"]
    neb, neb_a = P["nebula"]
    star, star_a = P["star"]
    out += f'  <path android:pathData="M0,0h108v108h-108z"><aapt:attr name="android:fillColor">{vd_lin(54, 0, 54, 108, [(0, argb(top, 1)), (1, argb(bottom, 1))])}</aapt:attr></path>\n'
    out += f'  <path android:pathData="M0,0h108v108h-108z"><aapt:attr name="android:fillColor">{vd_rad(54, 54, 50, [(0, argb(neb, neb_a)), (1, argb(neb, 0))])}</aapt:attr></path>\n'
    for cx, cy, r, a in STARS:
        out += f'  <path android:pathData="{circle(cx, cy, r)}" android:fillColor="{argb(star, 1)}" android:fillAlpha="{a * star_a:.2f}"/>\n'
    return out + "</vector>\n"


def arm_layers_vd(P):
    out = ""
    for phase, color in zip(PHASES, P["arms"]):
        for scale, alpha in [(4.2, 0.09), (2.4, 0.26)]:  # glow
            d, _ = arm_points(phase, width_scale=scale)
            out += f'  <path android:pathData="{d}" android:fillColor="{argb(color, alpha)}"/>\n'
        for d, c, a in arm_segments(phase, color, P["hot"]):
            out += f'  <path android:pathData="{d}" android:fillColor="{argb(c, a)}"/>\n'
    return out


def foreground_vd(P):
    ring = opaque(P["ring"])
    out = HEAD
    out += f'  <path android:pathData="{circle(C, C, RING_R + 3.5)}" android:strokeWidth="7" android:strokeAlpha="0.2"><aapt:attr name="android:strokeColor">{vd_lin(25, 25, 83, 83, ring)}</aapt:attr></path>\n'
    out += f'  <path android:pathData="{circle(C, C, RING_R)}"><aapt:attr name="android:fillColor">{vd_rad(54, 54, RING_R, opaque(P["core"]))}</aapt:attr></path>\n'
    out += f'  <path android:pathData="{circle(C, C, RING_R)}" android:strokeWidth="{RING_W}"><aapt:attr name="android:strokeColor">{vd_lin(25, 25, 83, 83, ring)}</aapt:attr></path>\n'
    out += arm_layers_vd(P)
    out += f'  <path android:pathData="{circle(C, C, 13)}"><aapt:attr name="android:fillColor">{vd_rad(54, 54, 13, [(0, argb(P["glow"], 0.6)), (1, argb(P["glow"], 0))])}</aapt:attr></path>\n'
    out += f'  <path android:pathData="{SPARK}"><aapt:attr name="android:fillColor">{vd_rad(54, 54, 11, [(0, "#FFFFFFFF"), (1, argb(P["spark_end"], 1))])}</aapt:attr></path>\n'
    return out + "</vector>\n"


def mono_vd(color="#FF000000", stroke=RING_W, head=HEAD, scale=None):
    body = f'  <path android:pathData="{circle(C, C, RING_R)}" android:strokeColor="{color}" android:strokeWidth="{stroke}"/>\n'
    for phase in PHASES:
        d, _ = arm_points(phase, width_scale=1.25)
        body += f'  <path android:pathData="{d}" android:fillColor="{color}"/>\n'
    body += f'  <path android:pathData="{SPARK}" android:fillColor="{color}"/>\n'
    if scale:
        body = f'  <group android:pivotX="54" android:pivotY="54" android:scaleX="{scale}" android:scaleY="{scale}">\n{body}  </group>\n'
    return head + body + "</vector>\n"


def svg(P):
    top, bottom = P["bg"]
    neb, neb_a = P["nebula"]
    star, star_a = P["star"]
    stops = lambda st: "".join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in st)
    o = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="432" height="432">', "<defs>",
         f'<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{top}"/><stop offset="1" stop-color="{bottom}"/></linearGradient>',
         f'<radialGradient id="neb" cx="54" cy="54" r="50" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="{neb}" stop-opacity="{neb_a}"/><stop offset="1" stop-color="{neb}" stop-opacity="0"/></radialGradient>',
         f'<linearGradient id="ring" x1="25" y1="25" x2="83" y2="83" gradientUnits="userSpaceOnUse">{stops(P["ring"])}</linearGradient>',
         f'<radialGradient id="core" cx="54" cy="54" r="{RING_R}" gradientUnits="userSpaceOnUse">{stops(P["core"])}</radialGradient>',
         f'<radialGradient id="glow" cx="54" cy="54" r="13" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="{P["glow"]}" stop-opacity=".6"/><stop offset="1" stop-color="{P["glow"]}" stop-opacity="0"/></radialGradient>',
         f'<radialGradient id="spark" cx="54" cy="54" r="11" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="{P["spark_end"]}"/></radialGradient>']
    arms = []
    for phase, color in zip(PHASES, P["arms"]):
        for scale, alpha in [(4.2, 0.09), (2.4, 0.26)]:
            arms.append(f'<path d="{arm_points(phase, width_scale=scale)[0]}" fill="{color}" fill-opacity="{alpha}"/>')
        arms += [f'<path d="{d}" fill="{c}" fill-opacity="{a:.2f}"/>' for d, c, a in arm_segments(phase, color, P["hot"])]
    o.append("</defs>")
    o += ['<rect width="108" height="108" fill="url(#bg)"/>', '<rect width="108" height="108" fill="url(#neb)"/>']
    o += [f'<circle cx="{x}" cy="{y}" r="{r}" fill="{star}" opacity="{a * star_a:.2f}"/>' for x, y, r, a in STARS]
    o += [f'<circle cx="54" cy="54" r="{RING_R + 3.5}" fill="none" stroke="url(#ring)" stroke-width="7" stroke-opacity=".2"/>',
          f'<circle cx="54" cy="54" r="{RING_R}" fill="url(#core)"/>',
          f'<circle cx="54" cy="54" r="{RING_R}" fill="none" stroke="url(#ring)" stroke-width="{RING_W}"/>']
    o += arms
    o += ['<circle cx="54" cy="54" r="13" fill="url(#glow)"/>', f'<path d="{SPARK}" fill="url(#spark)"/>', "</svg>"]
    return "\n".join(o) + "\n"


def alias_block(themes):
    """One launcher entry per theme; the app enables the one matching its theme (see LauncherIcon.kt)."""
    out = ["        <!-- ICON ALIASES (generated by art/gen_icon.py) -->"]
    for i, t in enumerate(themes):
        key = t["id"].replace("-", "_")
        out += [
            "        <activity-alias",
            f'            android:name=".Icon_{key}"',
            f'            android:enabled="{"true" if i == 0 else "false"}"',
            '            android:exported="true"',
            f'            android:icon="@mipmap/ic_launcher_{key}"',
            f'            android:roundIcon="@mipmap/ic_launcher_{key}"',
            '            android:targetActivity=".MainActivity">',
            "            <intent-filter>",
            '                <action android:name="android.intent.action.MAIN" />',
            '                <category android:name="android.intent.category.LAUNCHER" />',
            "            </intent-filter>",
            "        </activity-alias>",
        ]
    out.append("        <!-- END ICON ALIASES -->")
    return "\n".join(out)


if __name__ == "__main__":
    themes = json.load(open("art/themes.json"))
    res = "app/src/main/res/"
    os.makedirs("art/themes", exist_ok=True)
    for i, t in enumerate(themes):
        P = palette(t)
        key = t["id"].replace("-", "_")
        open(f"art/themes/{key}.svg", "w").write(svg(P))
        open(f"{res}drawable/ic_launcher_background_{key}.xml", "w").write(background_vd(P))
        open(f"{res}drawable/ic_launcher_foreground_{key}.xml", "w").write(foreground_vd(P))
        open(f"{res}mipmap-anydpi-v26/ic_launcher_{key}.xml", "w").write(
            '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
            f'    <background android:drawable="@drawable/ic_launcher_background_{key}"/>\n'
            f'    <foreground android:drawable="@drawable/ic_launcher_foreground_{key}"/>\n'
            '    <monochrome android:drawable="@drawable/ic_launcher_monochrome"/>\n</adaptive-icon>\n'
        )
        if i == 0:  # the first (default) theme is also the app's own icon
            open("art/portal-icon.svg", "w").write(svg(P))
            open(res + "drawable/ic_launcher_background.xml", "w").write(background_vd(P))
            open(res + "drawable/ic_launcher_foreground.xml", "w").write(foreground_vd(P))
    open(res + "drawable/ic_launcher_monochrome.xml", "w").write(mono_vd())
    manifest = "app/src/main/AndroidManifest.xml"
    m = open(manifest).read()
    m = re.sub(r"        <!-- ICON ALIASES.*?<!-- END ICON ALIASES -->", lambda _: alias_block(themes), m, flags=re.S)
    open(manifest, "w").write(m)
    res = "app/src/main/res/drawable/"
    small_head = HEAD.replace('android:width="108dp" android:height="108dp"', 'android:width="24dp" android:height="24dp"')
    open(res + "ic_notification.xml", "w").write(mono_vd("#FFFFFFFF", 5.5, small_head, scale=1.45))
    print(f"logo written for {len(themes)} themes")
