"""JSON API for the kids check-in app (plain WSGI, no framework).

Auth: two PINs. The *admin* PIN opens the admin screens; the *kiosk* PIN
unlocks a check-in device once. Both produce signed bearer tokens.
"""
import csv
import datetime
import io
import json
import os
import re
import secrets
import sys
import traceback
from urllib.parse import parse_qs

from . import labels as L
from .db import (Db, DEFAULT_SETTINGS, NoDatabase, age_on, classroom_for, digits, format_phone, hash_pin, new_id,
                 now_iso, sign_token, utcnow, verify_pin, verify_token)
from .importer import detect_mapping, parse_csv, propose_households

VERSION = "1.0.0"
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
ADMIN_TTL = 12 * 3600
KIOSK_TTL = 365 * 86400
MAX_BODY = 8 * 1024 * 1024


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class Response:
    def __init__(self, body, status=200, content_type="application/json; charset=utf-8", headers=None):
        self.body = body if isinstance(body, bytes) else body.encode("utf-8")
        self.status = status
        self.content_type = content_type
        self.headers = headers or []


class Request:
    def __init__(self, environ):
        self.method = environ.get("REQUEST_METHOD", "GET").upper()
        self.path = environ.get("PATH_INFO", "") or "/"
        self.query = {k: v[-1] for k, v in parse_qs(environ.get("QUERY_STRING", "")).items()}
        self.headers = {k[5:].replace("_", "-").lower(): v for k, v in environ.items() if k.startswith("HTTP_")}
        self.body = {}
        self.role = None
        try:
            length = int(environ.get("CONTENT_LENGTH") or 0)
        except ValueError:
            length = 0
        if length > MAX_BODY:
            raise ApiError(413, "Request too large")
        if length:
            raw = environ["wsgi.input"].read(length)
            try:
                self.body = json.loads(raw.decode("utf-8")) if raw.strip() else {}
            except ValueError:
                raise ApiError(400, "Body must be JSON")
            if not isinstance(self.body, dict):
                raise ApiError(400, "Body must be a JSON object")

    def str(self, key, default="", source=None):
        value = (source if source is not None else self.body).get(key, default)
        return str(value).strip() if value is not None else default


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def today_iso():
    return datetime.date.today().isoformat()


def time_text(local_time):
    try:
        h = int(local_time[:2])
        m = local_time[3:5]
        return "%d:%s %s" % (h % 12 or 12, m, "AM" if h < 12 else "PM")
    except Exception:
        return local_time or ""


def date_text(local_date):
    try:
        d = datetime.date.fromisoformat(local_date[:10])
        return "%s %d" % (d.strftime("%b"), d.day)
    except Exception:
        return local_date or ""


def in_clause(prefix, values):
    names = ["%s%d" % (prefix, i) for i in range(len(values))]
    return ", ".join(":" + n for n in names), dict(zip(names, values))


def norm_date(value):
    value = (value or "").strip()
    if not value:
        return None
    try:
        return datetime.date.fromisoformat(value[:10]).isoformat()
    except ValueError:
        pass
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", value)
    if m:
        try:
            return datetime.date(int(m.group(3)), int(m.group(1)), int(m.group(2))).isoformat()
        except ValueError:
            pass
    raise ApiError(400, "Birthday must be a date (YYYY-MM-DD)")


def person_out(p, classrooms, date):
    age = age_on(p["birthdate"], date) if p.get("birthdate") else None
    room = classroom_for(age, classrooms, p.get("classroom_override")) if p["role"] == "child" else None
    return {
        "id": p["id"], "family_id": p["family_id"], "role": p["role"],
        "first_name": p["first_name"], "last_name": p["last_name"],
        "phone": p.get("phone") or "", "phone_display": format_phone(p.get("phone")),
        "email": p.get("email") or "", "birthdate": p.get("birthdate") or "", "age": age,
        "allergies": p.get("allergies") or "", "notes": p.get("notes") or "",
        "classroom_override": p.get("classroom_override") or "",
        "classroom": room["id"] if room else None, "classroom_name": room["name"] if room else None,
        "external_id": p.get("external_id") or "", "active": p.get("active", 1),
    }


def checkin_out(c):
    return {
        "id": c["id"], "person_id": c["person_id"], "family_id": c["family_id"], "code": c["code"],
        "classroom": c.get("classroom"), "classroom_name": c.get("classroom_name"),
        "service_date": c["service_date"], "checked_in_local": c["checked_in_local"],
        "checked_in_time": time_text(c["checked_in_local"][11:16]) if len(c["checked_in_local"]) >= 16 else "",
        "checked_out_local": c.get("checked_out_local"),
        "checked_out_time": time_text(c["checked_out_local"][11:16]) if c.get("checked_out_local") else "",
        "first_name": c.get("first_name"), "last_name": c.get("last_name"), "age": c.get("age"),
        "allergies": c.get("allergies") or "", "notes": c.get("notes") or "",
    }


def load_families(db, ids, date, settings, include_inactive_people=False):
    if not ids:
        return []
    clause, params = in_clause("f", ids)
    fams = db.query("SELECT * FROM families WHERE id IN (%s)" % clause, **params)
    people = db.query(
        "SELECT * FROM people WHERE family_id IN (%s)%s ORDER BY role, first_name, last_name"
        % (clause, "" if include_inactive_people else " AND active = 1"), **params)
    checkins = db.query(
        "SELECT * FROM checkins WHERE family_id IN (%s) AND service_date = :d ORDER BY checked_in_at" % clause,
        d=date, **params)
    latest = {}
    for c in checkins:
        latest[c["person_id"]] = c
    by_family = {f["id"]: f for f in fams}
    out = []
    for fid in ids:
        f = by_family.get(fid)
        if not f:
            continue
        parents, children = [], []
        for p in people:
            if p["family_id"] != fid:
                continue
            po = person_out(p, settings["classrooms"], date)
            if p["role"] == "child":
                c = latest.get(p["id"])
                po["checkin"] = checkin_out(c) if c else None
                children.append(po)
            else:
                parents.append(po)
        out.append({
            "id": f["id"], "name": f["name"], "phone": f.get("phone") or "", "phone_display": format_phone(f.get("phone")),
            "email": f.get("email") or "", "notes": f.get("notes") or "", "active": f.get("active", 1),
            "parents": parents, "children": children, "date": date,
            "created_at": f.get("created_at"), "updated_at": f.get("updated_at"),
        })
    return out


def family_detail(db, fid, date, settings):
    fams = load_families(db, [fid], date, settings)
    if not fams:
        raise ApiError(404, "Family not found")
    return fams[0]


def family_summary(fam):
    phone = digits(fam.get("phone"))
    return {
        "id": fam["id"], "name": fam["name"],
        "phone_hint": ("•••-" + phone[-4:]) if len(phone) >= 4 else "",
        "parents": [p["first_name"] for p in fam["parents"]][:4],
        "children": [p["first_name"] for p in fam["children"]][:6],
        "child_count": len(fam["children"]),
    }


def family_name_from(parents, children):
    names = [p.get("last_name", "").strip() for p in (parents or []) if p.get("last_name", "").strip()]
    if not names:
        names = [c.get("last_name", "").strip() for c in (children or []) if c.get("last_name", "").strip()]
    if not names:
        return "New Family"
    uniq = list(dict.fromkeys(names))
    return (uniq[0] + " Family") if len(uniq) == 1 else " / ".join(uniq[:2])


def insert_person(db, fid, p, role, now):
    first = (p.get("first_name") or "").strip()
    last = (p.get("last_name") or "").strip()
    if not first:
        raise ApiError(400, "Each person needs a first name")
    pid = new_id()
    db.execute(
        """INSERT INTO people (id, family_id, role, first_name, last_name, phone, email, birthdate, allergies, notes,
           classroom_override, external_id, active, created_at, updated_at)
           VALUES (:id, :fid, :role, :first, :last, :phone, :email, :birthdate, :allergies, :notes, :override, :ext, 1, :now, :now)""",
        id=pid, fid=fid, role=role, first=first, last=last, phone=digits(p.get("phone")) or None,
        email=(p.get("email") or "").strip().lower() or None, birthdate=norm_date(p.get("birthdate")),
        allergies=(p.get("allergies") or "").strip() or None, notes=(p.get("notes") or "").strip() or None,
        override=(p.get("classroom_override") or "").strip() or None, ext=(p.get("external_id") or "").strip() or None,
        now=now)
    return pid


def new_code(db, date):
    code = ""
    for _ in range(25):
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(4))
        if not db.one("SELECT id FROM checkins WHERE service_date = :d AND code = :c", d=date, c=code):
            return code
    return code


def stamp_text(service_date, local_stamp):
    """'Sun. 11/2 @ 10:00AM' from the service date and the local check-in time."""
    try:
        d = datetime.date.fromisoformat(service_date[:10])
        day = "%s. %d/%d" % (d.strftime("%a"), d.month, d.day)
    except Exception:
        day = service_date or ""
    t = time_text((local_stamp or "")[11:16]).replace(" ", "")
    return (day + " @ " + t) if t else day


def primary_parent(db, fam):
    """First adult on the family: {'name', 'phone'} for the label footer."""
    row = db.one(
        """SELECT first_name, last_name, phone FROM people WHERE family_id = :fid AND role = 'adult' AND active = 1
           ORDER BY created_at, first_name""", fid=fam["id"])
    if not row:
        return {"name": fam.get("name") or "", "phone": format_phone(fam.get("phone"))}
    return {"name": ("%s %s" % (row["first_name"], row["last_name"] or "")).strip(),
            "phone": format_phone(row.get("phone") or fam.get("phone"))}


def label_set(settings, fam, checkins, include_parent, parent=None):
    """Build the ZPL + display fields for a list of check-in rows."""
    cfg = settings["label"]
    org = settings.get("org_name") or ""
    parent = parent or {"name": "", "phone": ""}
    out = []
    for c in checkins:
        fields = {
            "org": org, "first_name": c["first_name"], "last_name": c["last_name"],
            "classroom": c.get("classroom_name") or "No classroom", "age_text": ("Age %s" % c["age"]) if c.get("age") is not None else "",
            "allergies": c.get("allergies") or "", "notes": c.get("notes") or "", "code": c["code"],
            "time_text": time_text(c["checked_in_local"][11:16]), "date_text": date_text(c["service_date"]),
            "stamp_text": stamp_text(c["service_date"], c["checked_in_local"]),
            "parent_name": parent["name"], "parent_phone": parent["phone"],
        }
        out.append({"kind": "child", "checkin_id": c["id"], "person_id": c["person_id"], "fields": fields,
                    "zpl": L.child_label(fields, cfg)})
    if include_parent and checkins and cfg.get("parent_receipt", True):
        first = checkins[0]
        fields = {"org": org, "code": first["code"], "children": [c["first_name"] for c in checkins],
                  "time_text": time_text(first["checked_in_local"][11:16]), "date_text": date_text(first["service_date"]),
                  "stamp_text": stamp_text(first["service_date"], first["checked_in_local"]),
                  "family": fam["name"] if fam else ""}
        out.append({"kind": "parent", "fields": fields, "zpl": L.parent_label(fields, cfg)})
    return out


def validate_classrooms(rooms):
    if not isinstance(rooms, list) or not rooms:
        raise ApiError(400, "At least one classroom is required")
    out, seen = [], set()
    for r in rooms:
        name = str(r.get("name", "")).strip()
        if not name:
            raise ApiError(400, "Every classroom needs a name")
        rid = str(r.get("id") or re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "room").strip()
        base, n = rid, 2
        while rid in seen:
            rid = "%s-%d" % (base, n)
            n += 1
        seen.add(rid)
        try:
            max_age = int(r.get("max_age"))
        except (TypeError, ValueError):
            raise ApiError(400, "Classroom '%s' needs a maximum age" % name)
        out.append({"id": rid, "name": name, "max_age": max_age})
    out.sort(key=lambda r: r["max_age"])
    return out


def validate_label(cfg):
    base = dict(DEFAULT_SETTINGS["label"])
    base.update({k: v for k, v in (cfg or {}).items() if k in base})
    for key in ("width_in", "height_in"):
        try:
            base[key] = float(base[key])
        except (TypeError, ValueError):
            raise ApiError(400, "Label size must be a number")
        if not 0.5 <= base[key] <= 8:
            raise ApiError(400, "Label size must be between 0.5 and 8 inches")
    if int(base["dpi"]) not in (203, 300, 600):
        raise ApiError(400, "DPI must be 203, 300 or 600")
    base["dpi"] = int(base["dpi"])
    for key in ("rotate", "show_org", "show_allergies", "show_notes", "show_code", "parent_receipt"):
        base[key] = bool(base[key])
    return base


# --------------------------------------------------------------------------
# handlers
# --------------------------------------------------------------------------
def h_status(req, db):
    raw = db.raw_settings()
    s = db.settings()
    return {"setup_required": not raw.get("admin_pin"), "org_name": s["org_name"], "version": VERSION, "db": db.kind,
            "kiosk_pin_required": bool(s.get("kiosk_pin_required"))}


def h_setup(req, db):
    raw = db.raw_settings()
    if raw.get("admin_pin"):
        raise ApiError(403, "Setup was already completed")
    admin_pin = req.str("admin_pin")
    kiosk_pin = req.str("kiosk_pin")
    if len(admin_pin) < 4:
        raise ApiError(400, "Admin PIN must be at least 4 characters")
    db.set_setting("admin_pin", hash_pin(admin_pin))
    if kiosk_pin:
        db.set_setting("kiosk_pin", hash_pin(kiosk_pin))
    org = req.str("org_name")
    if org:
        db.set_setting("org_name", org[:80])
    token, expires = sign_token(db.secret(), "admin", ADMIN_TTL)
    return {"token": token, "role": "admin", "expires": expires}


def h_auth(req, db):
    role = req.str("role")
    pin = req.str("pin")
    if role not in ("admin", "kiosk"):
        raise ApiError(400, "role must be admin or kiosk")
    raw = db.raw_settings()
    if not raw.get("admin_pin"):
        raise ApiError(409, "Setup required")
    fail = raw.get("auth_fail_" + role) or {}
    if fail.get("until") and fail["until"] > now_iso():
        raise ApiError(429, "Too many attempts. Try again in 15 minutes.")
    master = os.environ.get("ADMIN_PIN")
    ok = verify_pin(pin, raw.get(role + "_pin"))
    if not ok and role == "kiosk":
        ok = verify_pin(pin, raw.get("admin_pin"))  # the admin PIN also unlocks a kiosk
    if not ok and master and pin == master:
        ok = True
    if not ok:
        count = int(fail.get("count", 0)) + 1
        until = None
        if count >= 8:
            until = (utcnow() + datetime.timedelta(minutes=15)).replace(microsecond=0, tzinfo=None).isoformat() + "Z"
            count = 0
        db.set_setting("auth_fail_" + role, {"count": count, "until": until})
        raise ApiError(401, "Incorrect PIN")
    if fail:
        db.set_setting("auth_fail_" + role, {"count": 0, "until": None})
    token, expires = sign_token(db.secret(), role, ADMIN_TTL if role == "admin" else KIOSK_TTL)
    return {"token": token, "role": role, "expires": expires}


def h_get_settings(req, db):
    s = db.settings()
    s["role"] = req.role
    return s


def h_put_settings(req, db):
    b = req.body
    if "org_name" in b:
        db.set_setting("org_name", req.str("org_name")[:80] or DEFAULT_SETTINGS["org_name"])
    if "classrooms" in b:
        db.set_setting("classrooms", validate_classrooms(b["classrooms"]))
    if "label" in b:
        db.set_setting("label", validate_label(b["label"]))
    if "print_method" in b:
        method = req.str("print_method")
        if method not in ("browserprint", "dialog"):
            raise ApiError(400, "print_method must be browserprint or dialog")
        db.set_setting("print_method", method)
    if "kiosk_auto_return_seconds" in b:
        try:
            db.set_setting("kiosk_auto_return_seconds", max(5, min(120, int(b["kiosk_auto_return_seconds"]))))
        except (TypeError, ValueError):
            raise ApiError(400, "Auto-return must be a number of seconds")
    if "preselect_children" in b:
        db.set_setting("preselect_children", bool(b["preselect_children"]))
    if "kiosk_pin_required" in b:
        db.set_setting("kiosk_pin_required", bool(b["kiosk_pin_required"]))
    return db.settings()


def h_change_pin(req, db):
    role = req.str("role")
    new_pin = req.str("new_pin")
    if role not in ("admin", "kiosk"):
        raise ApiError(400, "role must be admin or kiosk")
    if len(new_pin) < 4:
        raise ApiError(400, "PIN must be at least 4 characters")
    db.set_setting(role + "_pin", hash_pin(new_pin))
    return {"ok": True}


def h_search(req, db):
    q = req.query.get("q", "").strip()
    date = req.query.get("date") or today_iso()
    if len(q) < 2:
        return {"results": []}
    settings = db.settings()
    qd = digits(q)
    if len(qd) >= 3 and re.fullmatch(r"[\d\s()+\-.]+", q):
        rows = db.query(
            """SELECT DISTINCT f.id, f.name FROM families f
               LEFT JOIN people p ON p.family_id = f.id AND p.active = 1
               WHERE f.active = 1 AND (f.phone LIKE :qd OR p.phone LIKE :qd) ORDER BY f.name""", qd="%" + qd + "%")
    else:
        like = "%" + q.lower() + "%"
        rows = db.query(
            """SELECT DISTINCT f.id, f.name FROM families f
               LEFT JOIN people p ON p.family_id = f.id AND p.active = 1
               WHERE f.active = 1 AND (LOWER(f.name) LIKE :like OR LOWER(p.first_name) LIKE :like
                     OR LOWER(p.last_name) LIKE :like OR LOWER(p.first_name || ' ' || p.last_name) LIKE :like)
               ORDER BY f.name""", like=like)
    ids = [r["id"] for r in rows][:12]
    fams = load_families(db, ids, date, settings)
    return {"results": [family_summary(f) for f in fams], "total": len(rows)}


def h_list_families(req, db):
    q = req.query.get("q", "").strip().lower()
    date = req.query.get("date") or today_iso()
    limit = max(1, min(200, int(req.query.get("limit", 50) or 50)))
    offset = max(0, int(req.query.get("offset", 0) or 0))
    include_inactive = req.query.get("inactive") == "1"
    settings = db.settings()
    where = "" if include_inactive else "WHERE f.active = 1"
    params = {}
    if q:
        where = (where + " AND " if where else "WHERE ") + \
            """(LOWER(f.name) LIKE :like OR f.phone LIKE :qd OR EXISTS (
                 SELECT 1 FROM people p WHERE p.family_id = f.id AND p.active = 1 AND
                 (LOWER(p.first_name) LIKE :like OR LOWER(p.last_name) LIKE :like)))"""
        params = {"like": "%" + q + "%", "qd": "%" + (digits(q) or "~~~") + "%"}
    total = db.one("SELECT COUNT(*) AS n FROM families f %s" % where, **params)["n"]
    rows = db.query("SELECT f.id FROM families f %s ORDER BY LOWER(f.name) LIMIT :limit OFFSET :offset" % where,
                    limit=limit, offset=offset, **params)
    fams = load_families(db, [r["id"] for r in rows], date, settings)
    return {"families": fams, "total": total, "limit": limit, "offset": offset}


def h_get_family(req, db, fid):
    date = req.query.get("date") or today_iso()
    return family_detail(db, fid, date, db.settings())


def h_create_family(req, db):
    b = req.body
    parents = b.get("parents") or []
    children = b.get("children") or []
    if not parents:
        raise ApiError(400, "Add at least one parent or guardian")
    for p in parents:
        if not (p.get("first_name") or "").strip():
            raise ApiError(400, "Each parent needs a first name")
    phone = digits(b.get("phone")) or next((digits(p.get("phone")) for p in parents if digits(p.get("phone"))), "")
    if req.role != "admin" and len(phone) < 7:
        raise ApiError(400, "A phone number is required so you can find your family next time")
    name = (b.get("name") or "").strip() or family_name_from(parents, children)
    email = (b.get("email") or "").strip().lower() or next(((p.get("email") or "").strip().lower() for p in parents if p.get("email")), "")
    now = now_iso()
    fid = new_id()
    db.begin()
    try:
        db.execute(
            """INSERT INTO families (id, name, phone, email, notes, active, created_at, updated_at)
               VALUES (:id, :name, :phone, :email, :notes, 1, :now, :now)""",
            id=fid, name=name[:120], phone=phone or None, email=email or None,
            notes=(b.get("notes") or "").strip() or None, now=now)
        for p in parents:
            insert_person(db, fid, p, "adult", now)
        for c in children:
            insert_person(db, fid, c, "child", now)
        db.commit()
    except Exception:
        db.rollback()
        raise
    return family_detail(db, fid, req.query.get("date") or b.get("date") or today_iso(), db.settings())


def h_update_family(req, db, fid):
    b = req.body
    fam = db.one("SELECT * FROM families WHERE id = :id", id=fid)
    if not fam:
        raise ApiError(404, "Family not found")
    fields = {
        "name": (b.get("name") or fam["name"]).strip()[:120] or fam["name"],
        "phone": digits(b.get("phone")) or None if "phone" in b else fam.get("phone"),
        "email": ((b.get("email") or "").strip().lower() or None) if "email" in b else fam.get("email"),
        "notes": ((b.get("notes") or "").strip() or None) if "notes" in b else fam.get("notes"),
        "active": 1 if b.get("active", fam.get("active", 1)) else 0,
    }
    db.execute(
        """UPDATE families SET name = :name, phone = :phone, email = :email, notes = :notes, active = :active,
           updated_at = :now WHERE id = :id""", id=fid, now=now_iso(), **fields)
    return family_detail(db, fid, req.query.get("date") or today_iso(), db.settings())


def h_merge_family(req, db, fid):
    """Move everyone (and their check-in history) from another family into this one."""
    other = (req.body.get("other_family_id") or "").strip()
    if not other or other == fid:
        raise ApiError(400, "Pick a different family to connect")
    target = db.one("SELECT * FROM families WHERE id = :id AND active = 1", id=fid)
    source = db.one("SELECT * FROM families WHERE id = :id AND active = 1", id=other)
    if not target or not source:
        raise ApiError(404, "Family not found")
    now = now_iso()
    db.begin()
    try:
        db.execute("UPDATE people SET family_id = :fid, updated_at = :now WHERE family_id = :src", fid=fid, src=other, now=now)
        db.execute("UPDATE checkins SET family_id = :fid WHERE family_id = :src", fid=fid, src=other)
        db.execute(
            "UPDATE families SET phone = :phone, email = :email, updated_at = :now WHERE id = :fid",
            fid=fid, now=now, phone=target.get("phone") or source.get("phone"), email=target.get("email") or source.get("email"))
        db.execute("UPDATE families SET active = 0, updated_at = :now WHERE id = :src", src=other, now=now)
        db.commit()
    except Exception:
        db.rollback()
        raise
    return family_detail(db, fid, req.body.get("date") or today_iso(), db.settings())


def h_delete_family(req, db, fid):
    n = db.execute("UPDATE families SET active = 0, updated_at = :now WHERE id = :id", id=fid, now=now_iso())
    if not n:
        raise ApiError(404, "Family not found")
    return {"ok": True}


def h_create_person(req, db):
    b = req.body
    fid = (b.get("family_id") or "").strip()
    role = (b.get("role") or "child").strip()
    if role not in ("child", "adult"):
        raise ApiError(400, "role must be child or adult")
    if not db.one("SELECT id FROM families WHERE id = :id AND active = 1", id=fid):
        raise ApiError(404, "Family not found")
    pid = insert_person(db, fid, b, role, now_iso())
    fam = family_detail(db, fid, b.get("date") or today_iso(), db.settings())
    person = next((p for p in fam["parents"] + fam["children"] if p["id"] == pid), None)
    return {"person": person, "family": fam}


def h_update_person(req, db, pid):
    b = req.body
    p = db.one("SELECT * FROM people WHERE id = :id", id=pid)
    if not p:
        raise ApiError(404, "Person not found")
    first = (b.get("first_name") or p["first_name"]).strip() or p["first_name"]
    last = (b.get("last_name") if "last_name" in b else p["last_name"]) or ""
    role = b["role"] if b.get("role") in ("child", "adult") else p["role"]
    override = p.get("classroom_override")
    if "classroom_override" in b:
        override = (b.get("classroom_override") or "").strip() or None
        if override and not any(r["id"] == override for r in db.settings()["classrooms"]):
            raise ApiError(400, "Unknown classroom")
    family_id = p["family_id"]
    if req.role == "admin":
        if b.get("family_id") and db.one("SELECT id FROM families WHERE id = :id", id=b["family_id"]):
            family_id = b["family_id"]
    db.execute(
        """UPDATE people SET family_id = :fid, role = :role, first_name = :first, last_name = :last, phone = :phone,
           email = :email, birthdate = :birthdate, allergies = :allergies, notes = :notes,
           classroom_override = :override, updated_at = :now WHERE id = :id""",
        id=pid, fid=family_id, role=role, first=first[:60], last=str(last).strip()[:60],
        phone=(digits(b.get("phone")) or None) if "phone" in b else p.get("phone"),
        email=((b.get("email") or "").strip().lower() or None) if "email" in b else p.get("email"),
        birthdate=norm_date(b.get("birthdate")) if "birthdate" in b else p.get("birthdate"),
        allergies=((b.get("allergies") or "").strip() or None) if "allergies" in b else p.get("allergies"),
        notes=((b.get("notes") or "").strip() or None) if "notes" in b else p.get("notes"),
        override=override, now=now_iso())
    fam = family_detail(db, family_id, b.get("date") or req.query.get("date") or today_iso(), db.settings())
    person = next((x for x in fam["parents"] + fam["children"] if x["id"] == pid), None)
    return {"person": person, "family": fam}


def h_delete_person(req, db, pid):
    n = db.execute("UPDATE people SET active = 0, updated_at = :now WHERE id = :id", id=pid, now=now_iso())
    if not n:
        raise ApiError(404, "Person not found")
    return {"ok": True}


def h_checkin(req, db):
    b = req.body
    fid = (b.get("family_id") or "").strip()
    ids = [str(x) for x in (b.get("person_ids") or [])]
    local_date = norm_date(b.get("local_date")) or today_iso()
    local_time = (b.get("local_time") or datetime.datetime.now().strftime("%H:%M"))[:5]
    settings = db.settings()
    fam = family_detail(db, fid, local_date, settings)
    if not ids:
        raise ApiError(400, "Select at least one child")
    chosen = [c for c in fam["children"] if c["id"] in ids]
    if not chosen:
        raise ApiError(400, "Select at least one child")
    for c in chosen:
        if c["age"] is None and not c["classroom_override"]:
            raise ApiError(400, "%s needs a birthday before checking in" % c["first_name"])

    already = [c for c in chosen if c.get("checkin") and not c["checkin"].get("checked_out_local")]
    fresh = [c for c in chosen if c not in already]
    code = already[0]["checkin"]["code"] if already else None
    if not code:
        active_today = db.one(
            "SELECT code FROM checkins WHERE family_id = :fid AND service_date = :d AND checked_out_at IS NULL ORDER BY checked_in_at DESC",
            fid=fid, d=local_date)
        code = active_today["code"] if active_today else new_code(db, local_date)

    now = now_iso()
    local_stamp = "%sT%s" % (local_date, local_time)
    created = []
    db.begin()
    try:
        for c in fresh:
            cid = new_id()
            db.execute(
                """INSERT INTO checkins (id, person_id, family_id, classroom, classroom_name, code, service_date,
                   checked_in_at, checked_in_local, first_name, last_name, age, allergies, notes)
                   VALUES (:id, :pid, :fid, :room, :room_name, :code, :d, :now, :local, :first, :last, :age, :allergies, :notes)""",
                id=cid, pid=c["id"], fid=fid, room=c["classroom"], room_name=c["classroom_name"], code=code, d=local_date,
                now=now, local=local_stamp, first=c["first_name"], last=c["last_name"], age=c["age"],
                allergies=c["allergies"] or None, notes=c["notes"] or None)
            created.append(cid)
        db.commit()
    except Exception:
        db.rollback()
        raise
    rows = []
    if created:
        clause, params = in_clause("c", created)
        rows = db.query("SELECT * FROM checkins WHERE id IN (%s) ORDER BY checked_in_at, first_name" % clause, **params)
    labels = label_set(settings, fam, rows, include_parent=bool(rows), parent=primary_parent(db, fam))
    return {
        "code": code,
        "checkins": [checkin_out(r) for r in rows],
        "already_checked_in": [c["first_name"] for c in already],
        "labels": labels,
        "family": family_detail(db, fid, local_date, settings),
    }


def h_checkout(req, db, cid):
    c = db.one("SELECT * FROM checkins WHERE id = :id", id=cid)
    if not c:
        raise ApiError(404, "Check-in not found")
    local_time = (req.body.get("local_time") or datetime.datetime.now().strftime("%H:%M"))[:5]
    db.execute("UPDATE checkins SET checked_out_at = :now, checked_out_local = :local WHERE id = :id",
               id=cid, now=now_iso(), local="%sT%s" % (c["service_date"], local_time))
    return checkin_out(db.one("SELECT * FROM checkins WHERE id = :id", id=cid))


def h_undo_checkout(req, db, cid):
    n = db.execute("UPDATE checkins SET checked_out_at = NULL, checked_out_local = NULL WHERE id = :id", id=cid)
    if not n:
        raise ApiError(404, "Check-in not found")
    return checkin_out(db.one("SELECT * FROM checkins WHERE id = :id", id=cid))


def h_delete_checkin(req, db, cid):
    n = db.execute("DELETE FROM checkins WHERE id = :id", id=cid)
    if not n:
        raise ApiError(404, "Check-in not found")
    return {"ok": True}


def h_reprint(req, db):
    ids = [str(x) for x in (req.body.get("checkin_ids") or [])]
    if not ids:
        raise ApiError(400, "Nothing to print")
    clause, params = in_clause("c", ids)
    rows = db.query("SELECT * FROM checkins WHERE id IN (%s) ORDER BY checked_in_at, first_name" % clause, **params)
    if not rows:
        raise ApiError(404, "Check-in not found")
    settings = db.settings()
    fam = db.one("SELECT * FROM families WHERE id = :id", id=rows[0]["family_id"])
    return {"labels": label_set(settings, fam, rows, include_parent=bool(req.body.get("parent")), parent=primary_parent(db, fam))}


def h_roster(req, db):
    date = req.query.get("date") or today_iso()
    settings = db.settings()
    rows = db.query(
        """SELECT c.*, f.name AS family_name, f.phone AS family_phone FROM checkins c
           JOIN families f ON f.id = c.family_id WHERE c.service_date = :d ORDER BY c.first_name, c.last_name""", d=date)
    rooms = [{"id": r["id"], "name": r["name"], "max_age": r["max_age"], "checkins": []} for r in settings["classrooms"]]
    by_id = {r["id"]: r for r in rooms}
    unassigned = []
    for c in rows:
        item = checkin_out(c)
        item["family_name"] = c["family_name"]
        item["family_phone_display"] = format_phone(c.get("family_phone"))
        target = by_id.get(c.get("classroom"))
        (target["checkins"] if target else unassigned).append(item)
    for r in rooms:
        r["present"] = sum(1 for c in r["checkins"] if not c["checked_out_local"])
        r["total"] = len(r["checkins"])
    return {
        "date": date, "classrooms": rooms, "unassigned": unassigned,
        "present": sum(1 for c in rows if not c.get("checked_out_local")), "total": len(rows),
    }


def h_import_preview(req, db):
    text = req.body.get("csv") or ""
    if not text.strip():
        raise ApiError(400, "Upload a CSV file first")
    headers, records = parse_csv(text)
    if not records:
        raise ApiError(400, "No rows found in that CSV")
    mapping = req.body.get("mapping") or detect_mapping(headers)
    if "first_name" not in mapping and "last_name" not in mapping:
        raise ApiError(400, "Could not find a first/last name column. Headers: " + ", ".join(headers))
    today = req.body.get("local_date") or today_iso()
    households, stats = propose_households(records, mapping, today)
    ext_ids = [m["external_id"] for h in households for m in h["members"] if m["external_id"]]
    existing = set()
    for i in range(0, len(ext_ids), 200):
        clause, params = in_clause("e", ext_ids[i:i + 200])
        existing.update(r["external_id"] for r in db.query(
            "SELECT external_id FROM people WHERE active = 1 AND external_id IN (%s)" % clause, **params))
    for h in households:
        for m in h["members"]:
            m["existing"] = bool(m["external_id"] and m["external_id"] in existing)
        if h["members"] and all(m["existing"] for m in h["members"]):
            h["skip"] = True
            h["reason"] = "already imported"
    stats["existing"] = sum(1 for h in households for m in h["members"] if m["existing"])
    return {"headers": headers, "mapping": mapping, "households": households, "stats": stats}


def h_import_commit(req, db):
    households = req.body.get("households") or []
    if not isinstance(households, list):
        raise ApiError(400, "households must be a list")
    now = now_iso()
    created_f = created_p = skipped = attached = 0
    db.begin()
    try:
        for h in households:
            if h.get("skip"):
                skipped += len(h.get("members") or [])
                continue
            members = [m for m in (h.get("members") or []) if m.get("role") in ("child", "adult")]
            skipped += len([m for m in (h.get("members") or []) if m.get("role") not in ("child", "adult")])
            if not members:
                continue
            ext_ids = [m["external_id"] for m in members if m.get("external_id")]
            existing = {}
            if ext_ids:
                clause, params = in_clause("e", ext_ids)
                for r in db.query("SELECT external_id, family_id FROM people WHERE active = 1 AND external_id IN (%s)" % clause, **params):
                    existing[r["external_id"]] = r["family_id"]
            fid = next(iter(existing.values()), None)
            if fid is None:
                fid = new_id()
                db.execute(
                    """INSERT INTO families (id, name, phone, email, notes, active, created_at, updated_at)
                       VALUES (:id, :name, :phone, :email, NULL, 1, :now, :now)""",
                    id=fid, name=(h.get("name") or family_name_from(members, []))[:120],
                    phone=digits(h.get("phone")) or None, email=(h.get("email") or "").strip().lower() or None, now=now)
                created_f += 1
            else:
                attached += 1
            for m in members:
                if m.get("external_id") and m["external_id"] in existing:
                    skipped += 1
                    continue
                insert_person(db, fid, m, m["role"], now)
                created_p += 1
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {"families_created": created_f, "people_created": created_p, "skipped": skipped, "families_updated": attached}


def csv_response(filename, header, rows):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(header)
    for r in rows:
        w.writerow(r)
    return Response("﻿" + buf.getvalue(), content_type="text/csv; charset=utf-8",
                    headers=[("Content-Disposition", 'attachment; filename="%s"' % filename)])


def h_export_checkins(req, db):
    start = req.query.get("from") or "0000-01-01"
    end = req.query.get("to") or "9999-12-31"
    rows = db.query(
        """SELECT c.*, f.name AS family_name, f.phone AS family_phone FROM checkins c JOIN families f ON f.id = c.family_id
           WHERE c.service_date >= :s AND c.service_date <= :e ORDER BY c.service_date, c.checked_in_local""", s=start, e=end)
    out = [[c["service_date"], c["checked_in_local"][11:16], c["first_name"],
            c["last_name"], c.get("age"), c.get("classroom_name") or "", c.get("allergies") or "", c.get("notes") or "",
            c["code"], c["family_name"], format_phone(c.get("family_phone"))] for c in rows]
    return csv_response("checkins-%s-to-%s.csv" % (start, end),
                        ["Date", "Time", "First Name", "Last Name", "Age", "Classroom", "Allergies", "Notes",
                         "Code", "Family", "Family Phone"], out)


def h_export_families(req, db):
    rows = db.query(
        """SELECT p.*, f.name AS family_name, f.phone AS family_phone, f.email AS family_email FROM people p
           JOIN families f ON f.id = p.family_id WHERE p.active = 1 AND f.active = 1 ORDER BY LOWER(f.name), p.role, p.first_name""")
    out = [[r["family_name"], format_phone(r.get("family_phone")), r.get("family_email") or "", r["role"], r["first_name"],
            r["last_name"], format_phone(r.get("phone")), r.get("email") or "", r.get("birthdate") or "", r.get("allergies") or "",
            r.get("notes") or "", r.get("classroom_override") or "", r.get("external_id") or ""] for r in rows]
    return csv_response("families.csv", ["Family", "Family Phone", "Family Email", "Role", "First Name", "Last Name",
                                         "Phone", "Email", "Birthdate", "Allergies", "Notes", "Classroom Override",
                                         "External ID"], out)


def h_label_preview(req, db):
    settings = db.settings()
    cfg = validate_label(req.body.get("label") or settings["label"])
    org = req.body.get("org_name") or settings["org_name"]
    child = L.sample_child_fields(org)
    parent = L.sample_parent_fields(org)
    return {"label": cfg, "child": {"fields": child, "zpl": L.child_label(child, cfg)},
            "parent": {"fields": parent, "zpl": L.parent_label(parent, cfg)}}


# --------------------------------------------------------------------------
# routing
# --------------------------------------------------------------------------
ROUTES = [
    ("GET", r"/api/status", h_status, None),
    ("GET", r"/api/health", h_status, None),
    ("POST", r"/api/setup", h_setup, None),
    ("POST", r"/api/auth", h_auth, None),
    ("GET", r"/api/settings", h_get_settings, "kiosk"),
    ("PUT", r"/api/settings", h_put_settings, "admin"),
    ("POST", r"/api/settings/pin", h_change_pin, "admin"),
    ("GET", r"/api/search", h_search, "kiosk"),
    ("GET", r"/api/families", h_list_families, "admin"),
    ("POST", r"/api/families", h_create_family, "kiosk"),
    ("GET", r"/api/families/([a-f0-9]+)", h_get_family, "kiosk"),
    ("PUT", r"/api/families/([a-f0-9]+)", h_update_family, "admin"),
    ("DELETE", r"/api/families/([a-f0-9]+)", h_delete_family, "admin"),
    ("POST", r"/api/families/([a-f0-9]+)/merge", h_merge_family, "kiosk"),
    ("POST", r"/api/people", h_create_person, "kiosk"),
    ("PUT", r"/api/people/([a-f0-9]+)", h_update_person, "kiosk"),
    ("DELETE", r"/api/people/([a-f0-9]+)", h_delete_person, "admin"),
    ("POST", r"/api/checkins", h_checkin, "kiosk"),
    ("POST", r"/api/checkins/([a-f0-9]+)/checkout", h_checkout, "kiosk"),
    ("POST", r"/api/checkins/([a-f0-9]+)/undo-checkout", h_undo_checkout, "admin"),
    ("DELETE", r"/api/checkins/([a-f0-9]+)", h_delete_checkin, "kiosk"),  # "undo check-in" at the kiosk too
    ("POST", r"/api/labels/reprint", h_reprint, "kiosk"),
    ("POST", r"/api/labels/preview", h_label_preview, "admin"),
    ("GET", r"/api/roster", h_roster, "admin"),
    ("POST", r"/api/import/preview", h_import_preview, "admin"),
    ("POST", r"/api/import/commit", h_import_commit, "admin"),
    ("GET", r"/api/export/checkins", h_export_checkins, "admin"),
    ("GET", r"/api/export/families", h_export_families, "admin"),
]
COMPILED = [(m, re.compile("^" + pattern + "/?$"), h, auth) for m, pattern, h, auth in ROUTES]
STATUS_TEXT = {200: "OK", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
               405: "Method Not Allowed", 409: "Conflict", 413: "Payload Too Large", 429: "Too Many Requests",
               500: "Internal Server Error"}


def authenticate(req, db, required):
    if not required:
        return
    header = req.headers.get("authorization", "")
    token = header[7:].strip() if header.lower().startswith("bearer ") else req.query.get("token", "")
    role = verify_token(db.secret(), token) if token else None
    if role not in ("admin", "kiosk"):
        if required == "kiosk" and not db.settings().get("kiosk_pin_required"):
            req.role = "kiosk"  # kiosk PIN is switched off: the check-in page is open
            return
        raise ApiError(401, "Please sign in")
    if required == "admin" and role != "admin":
        raise ApiError(403, "Admin access required")
    req.role = role


def dispatch(req, db):
    path_matched = False
    for method, pattern, handler, auth in COMPILED:
        m = pattern.match(req.path)
        if not m:
            continue
        path_matched = True
        if method != req.method:
            continue
        authenticate(req, db, auth)
        result = handler(req, db, *m.groups())
        if isinstance(result, Response):
            return result
        return Response(json.dumps(result, default=str))
    raise ApiError(405 if path_matched else 404, "Method not allowed" if path_matched else "Not found")


def app(environ, start_response):
    db = None
    try:
        req = Request(environ)
        db = Db()
        resp = dispatch(req, db)
    except ApiError as e:
        resp = Response(json.dumps({"error": e.message}), status=e.status)
    except NoDatabase as e:
        resp = Response(json.dumps({"error": str(e), "setup": "database"}), status=503)
    except Exception as e:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        detail = {"error": "Server error: %s" % (str(e)[:300] or e.__class__.__name__)}
        if os.environ.get("DEBUG"):
            detail["trace"] = traceback.format_exc()
        resp = Response(json.dumps(detail), status=500)
    finally:
        if db:
            db.close()
    headers = [("Content-Type", resp.content_type), ("Cache-Control", "no-store"),
               ("Content-Length", str(len(resp.body)))] + resp.headers
    start_response("%d %s" % (resp.status, STATUS_TEXT.get(resp.status, "OK")), headers)
    return [resp.body]
