"""Zebra ZPL label generation.

Child label: name block on the left with thin rules between sections, and a
black bar on the right with the pickup code stacked vertically.
Parent tag: date/time, the code reversed in a black box, and a Code 128
barcode of the code.

Labels are laid out on a "logical" canvas whose x axis is the reading
direction. For a normal label that is the printer's width; when `rotate` is
on, the text reads along the label's length instead (tall name-badge stock).
"""

ALLERGY_PREFIX = "Allergy: "
TOP_MARGIN = 0.07  # fraction of the label height kept clear at the top and bottom


def _esc(text):
    """Escape for a ^FD field with ^FH (underscore hex) enabled."""
    text = str(text or "")
    return text.replace("_", "_5F").replace("^", "_5E").replace("~", "_7E")


def _fit(text, box_width, max_h, min_h=14, ratio=0.56):
    """Largest font height (dots) so that `text` fits in box_width."""
    n = max(len(text or ""), 1)
    h = int(box_width / (ratio * n))
    return max(min(h, int(max_h)), min_h)


class Canvas:
    def __init__(self, width_in, height_in, dpi, rotate=False):
        self.dpi = int(dpi)
        self.pw = int(round(float(width_in) * self.dpi))   # across the print head
        self.pl = int(round(float(height_in) * self.dpi))  # feed direction
        self.rotate = bool(rotate)
        # logical canvas: reading direction is x
        self.w, self.h = (self.pl, self.pw) if self.rotate else (self.pw, self.pl)
        self.parts = []

    def _phys(self, x, y, w, h):
        """Logical rectangle -> physical top-left and size."""
        if self.rotate:
            return self.pw - y - h, x, h, w
        return x, y, w, h

    def text(self, x, y, h, text, box_w=None, align="L", w=None, lines=1, reverse=False):
        """Place text whose top-left (logical) corner is x,y; wraps to `lines` lines."""
        if text is None or text == "":
            return
        box_w = int(box_w or (self.w - x))
        w = int(w or h)
        lines = max(int(lines), 1)
        orient = "R" if self.rotate else "N"
        px, py, _, _ = self._phys(int(x), int(y), box_w, int(h) * lines)
        just = {"L": "L", "C": "C", "R": "R"}.get(align, "L")
        self.parts.append(
            "^FO%d,%d^A0%s,%d,%d^FB%d,%d,0,%s,0%s^FH^FD%s^FS"
            % (px, py, orient, int(h), w, box_w, lines, just, "^FR" if reverse else "", _esc(text))
        )

    def box(self, x, y, w, h, thickness=2, fill=False, rounding=0, color="B"):
        px, py, pw, ph = self._phys(int(x), int(y), int(w), int(h))
        t = min(pw, ph) if fill else max(int(thickness), 1)
        self.parts.append("^FO%d,%d^GB%d,%d,%d,%s,%d^FS" % (px, py, pw, ph, t, color, int(rounding)))

    def rule(self, x, y, w, thickness=2):
        self.box(x, y, w, thickness, thickness)

    def diagonal(self, x, y, w, h, thickness, direction="R", color="B"):
        """^GD line inside the logical rect; direction R = bottom-left to top-right, L = the other."""
        px, py, pw, ph = self._phys(int(x), int(y), int(w), int(h))
        if self.rotate:
            direction = "L" if direction == "R" else "R"
        self.parts.append("^FO%d,%d^GD%d,%d,%d,%s,%s^FS" % (px, py, pw, ph, int(thickness), color, direction))

    def barcode128(self, x, y, height, data, module=2):
        """Code 128, centred on logical x (x is the centre line)."""
        if self.rotate:
            # keep it simple: draw it rotated with ^BC orientation R
            est_w = (11 * (len(data) + 2) + 13) * module
            px, py, _, _ = self._phys(int(x - est_w // 2), int(y), est_w, int(height))
            self.parts.append("^FO%d,%d^BY%d,3,%d^BCR,%d,N,N,N^FD%s^FS" % (px, py, module, int(height), int(height), data))
            return
        est_w = (11 * (len(data) + 2) + 13) * module
        self.parts.append("^FO%d,%d^BY%d,3,%d^BCN,%d,N,N,N^FD%s^FS" % (int(x - est_w // 2), int(y), module, int(height), int(height), data))

    def zpl(self):
        head = "^XA^CI28^PW%d^LL%d^LH0,0^LS0" % (self.pw, self.pl)
        return head + "".join(self.parts) + "^XZ"


def child_label(fields, label_cfg):
    """fields: first_name, last_name, classroom, stamp_text, allergies, notes,
    code, parent_name, parent_phone (org/date_text/time_text are kept for the screen)."""
    c = Canvas(label_cfg["width_in"], label_cfg["height_in"], label_cfg["dpi"], label_cfg.get("rotate"))
    W, H = c.w, c.h
    m = max(int(W * 0.05), 8)
    top = int(H * TOP_MARGIN)
    bottom = H - top
    code = (fields.get("code") or "") if label_cfg.get("show_code", True) else ""
    allergies = (fields.get("allergies") or "").strip() if label_cfg.get("show_allergies", True) else ""
    notes = (fields.get("notes") or "").strip() if label_cfg.get("show_notes") else ""

    # Right-hand code bar
    bar_w = int(W * 0.165) if code else 0
    bar_x = W - m - bar_w
    if code:
        c.box(bar_x, top, bar_w, bottom - top, fill=True, rounding=2)
        n = max(len(code), 1)
        slot = (bottom - top) * 0.94 / n
        glyph = int(min(bar_w * 0.62, slot * 0.82))
        for i, ch in enumerate(code):
            cy = top + int((bottom - top) * 0.03 + slot * i + (slot - glyph) / 2)
            c.text(bar_x, cy, glyph, ch, bar_w, "C", reverse=True)

    # Left column
    col_w = bar_x - m - (int(W * 0.04) if code else 0)
    y = top
    first = fields.get("first_name") or ""
    last = fields.get("last_name") or ""
    fh = _fit(first, col_w, H * 0.19, ratio=0.6)
    c.text(m, y, fh, first, col_w, "L")
    y += int(fh * 1.12)
    lh = _fit(last, col_w, H * 0.14, ratio=0.6)
    c.text(m, y, lh, last, col_w, "L")
    y += int(lh * 1.2)
    c.rule(m, y, col_w)
    y += int(H * 0.035)

    room = fields.get("classroom") or ""
    rh = _fit(room, col_w, H * 0.09)
    c.text(m, y, rh, room, col_w, "L")
    y += int(rh * 1.2)
    stamp = fields.get("stamp_text") or " ".join(filter(None, [fields.get("date_text"), fields.get("time_text")]))
    sh = _fit(stamp, col_w, H * 0.065)
    c.text(m, y, sh, stamp, col_w, "L")
    y += int(sh * 1.35)
    c.rule(m, y, col_w)
    y += int(H * 0.035)

    # Allergy row (left empty when there is none, like the sample)
    line = (ALLERGY_PREFIX + allergies) if allergies else ""
    if notes:
        line = (line + " · " if line else "") + notes
    ah = _fit(line, col_w, H * 0.075) if line else int(H * 0.075)
    c.text(m, y, ah, line, col_w, "L")
    y += int(H * 0.075 * 1.35)
    c.rule(m, y, col_w)
    y += int(H * 0.035)

    # Parent name (left) and phone (right), bottom-aligned
    pn = fields.get("parent_name") or ""
    pp = fields.get("parent_phone") or ""
    ph = int(H * 0.065)
    fy = max(y, bottom - int(ph * 1.1))
    if pp:
        c.text(m, fy, ph, pn, int(col_w * 0.58), "L")
        c.text(m + int(col_w * 0.58), fy, ph, pp, col_w - int(col_w * 0.58), "R")
    else:
        c.text(m, fy, ph, pn, col_w, "L")
    return c.zpl()


def parent_label(fields, label_cfg):
    """fields: code, stamp_text, children, org. Date/time, the code in a black box, a footer."""
    c = Canvas(label_cfg["width_in"], label_cfg["height_in"], label_cfg["dpi"], label_cfg.get("rotate"))
    W, H = c.w, c.h
    m = max(int(W * 0.05), 8)
    inner = W - 2 * m
    top = int(H * TOP_MARGIN)

    org = fields.get("org") if label_cfg.get("show_org", True) else ""
    stamp = fields.get("stamp_text") or " ".join(filter(None, [fields.get("date_text"), fields.get("time_text")]))
    code = fields.get("code") or ""
    kids = ", ".join(fields.get("children") or [])
    foot = "Retain for child pickup" + (" · " + kids if kids else "")

    oh = _fit(org, inner, H * 0.055, min_h=10) if org else 0
    sh = _fit(stamp, inner, H * 0.13)
    box_h = int(H * 0.36)
    fh = _fit(foot, inner, H * 0.065, min_h=10)
    gap = int(H * 0.04)
    total = (int(oh * 1.3) if org else 0) + int(sh * 1.3) + gap + box_h + gap + fh
    y = top + max((H - 2 * top - total) // 2, 0)

    if org:
        c.text(m, y, oh, org, inner, "C")
        y += int(oh * 1.3)
    c.text(m, y, sh, stamp, inner, "C")
    y += int(sh * 1.3) + gap
    box_x = m + int(inner * 0.06)
    box_w = inner - 2 * int(inner * 0.06)
    c.box(box_x, y, box_w, box_h, fill=True, rounding=1)
    ch = int(box_h * 0.66)
    c.text(box_x, y + (box_h - ch) // 2, ch, code, box_w, "C", w=int(ch * 1.05), reverse=True)
    y += box_h + gap
    c.text(m, y, fh, foot, inner, "C")
    return c.zpl()


def sample_child_fields(org="Kids Check-In"):
    return {
        "org": org, "first_name": "Emma", "last_name": "Johnson", "classroom": "PreK-2nd",
        "age_text": "Age 5", "allergies": "Peanuts", "notes": "Needs inhaler", "code": "K7Q2",
        "time_text": "10:00 AM", "date_text": "Nov 2", "stamp_text": "Sun. 11/2 @ 10:00AM",
        "parent_name": "Laura Johnson", "parent_phone": "(208) 555-0123",
    }


def sample_parent_fields(org="Kids Check-In"):
    return {"org": org, "code": "K7Q2", "children": ["Emma", "Noah"], "time_text": "10:00 AM", "date_text": "Nov 2",
            "stamp_text": "Sun. 11/2 @ 10:00AM"}
