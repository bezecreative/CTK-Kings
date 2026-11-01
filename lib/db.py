"""Database layer.

Uses SQLite locally (data/checkin.db) and Postgres when a DATABASE_URL /
POSTGRES_URL environment variable is present (Vercel + Neon/Supabase).
All SQL is written once, in a dialect both engines accept, with :name params.
"""
import datetime
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import ssl
from urllib.parse import parse_qs, unquote, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQLITE_PATH = os.environ.get("SQLITE_PATH") or os.path.join(ROOT, "data", "checkin.db")

DEFAULT_SETTINGS = {
    "org_name": "Christ The King",
    "classrooms": [
        {"id": "nursery", "name": "Nursery", "max_age": 3},
        {"id": "prek2", "name": "PreK-2nd", "max_age": 7},
        {"id": "3-5", "name": "3rd-5th", "max_age": 11},
    ],
    "label": {
        "width_in": 3,
        "height_in": 2,
        "dpi": 203,
        "rotate": False,
        "show_org": True,
        "show_allergies": True,
        "show_notes": False,
        "show_code": True,
        "parent_receipt": True,
    },
    "print_method": "browserprint",  # or "dialog"
    "kiosk_auto_return_seconds": 15,
    "preselect_children": True,
    "kiosk_pin_required": False,  # off: the check-in page opens without a PIN
}

# Keys that must never leave the server.
SECRET_KEYS = {"admin_pin", "kiosk_pin", "secret", "auth_fail_admin", "auth_fail_kiosk"}

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS families (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT,
        email TEXT,
        notes TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS people (
        id TEXT PRIMARY KEY,
        family_id TEXT NOT NULL,
        role TEXT NOT NULL,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        phone TEXT,
        email TEXT,
        birthdate TEXT,
        allergies TEXT,
        notes TEXT,
        classroom_override TEXT,
        external_id TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL)""",
    "CREATE INDEX IF NOT EXISTS idx_people_family ON people(family_id)",
    "CREATE INDEX IF NOT EXISTS idx_people_external ON people(external_id)",
    """CREATE TABLE IF NOT EXISTS checkins (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL,
        family_id TEXT NOT NULL,
        classroom TEXT,
        classroom_name TEXT,
        code TEXT NOT NULL,
        service_date TEXT NOT NULL,
        checked_in_at TEXT NOT NULL,
        checked_in_local TEXT NOT NULL,
        checked_out_at TEXT,
        checked_out_local TEXT,
        first_name TEXT,
        last_name TEXT,
        age INTEGER,
        allergies TEXT,
        notes TEXT)""",
    "CREATE INDEX IF NOT EXISTS idx_checkins_date ON checkins(service_date)",
    "CREATE INDEX IF NOT EXISTS idx_checkins_person ON checkins(person_id)",
]

_schema_ready = False


def pg_url():
    for key in ("DATABASE_URL", "POSTGRES_URL", "POSTGRES_URL_NON_POOLING", "DATABASE_URL_UNPOOLED"):
        value = os.environ.get(key)
        if value and re.match(r"^postgres(ql)?://", value):
            return value
    return None


class Db:
    def __init__(self):
        url = pg_url()
        if url:
            self.kind = "pg"
            self.con = self._connect_pg(url)
        else:
            self.kind = "sqlite"
            os.makedirs(os.path.dirname(SQLITE_PATH), exist_ok=True)
            self.con = sqlite3.connect(SQLITE_PATH, isolation_level=None, check_same_thread=False)
            self.con.row_factory = sqlite3.Row
            self.con.execute("PRAGMA journal_mode=WAL")
            self.con.execute("PRAGMA busy_timeout=5000")
        self.ensure_schema()

    @staticmethod
    def _connect_pg(url):
        import pg8000.native as pgn

        u = urlparse(url)
        q = parse_qs(u.query)
        sslmode = (q.get("sslmode") or ["require"])[0]
        kwargs = dict(
            user=unquote(u.username or ""),
            password=unquote(u.password or ""),
            host=u.hostname,
            port=u.port or 5432,
            database=(u.path or "/postgres").lstrip("/") or "postgres",
            timeout=15,
        )
        if sslmode == "disable":
            return pgn.Connection(**kwargs)
        ctx = ssl.create_default_context()
        try:
            return pgn.Connection(ssl_context=ctx, **kwargs)
        except ssl.SSLError:
            # libpq's "require" encrypts without verifying the certificate; match that.
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            return pgn.Connection(ssl_context=ctx, **kwargs)

    # -- core ---------------------------------------------------------------
    def query(self, sql, **params):
        if self.kind == "pg":
            rows = self.con.run(sql, **params)
            if rows is None:
                return []
            cols = [c["name"] for c in self.con.columns]
            return [dict(zip(cols, r)) for r in rows]
        cur = self.con.execute(sql, params)
        return [dict(r) for r in cur.fetchall()]

    def one(self, sql, **params):
        rows = self.query(sql, **params)
        return rows[0] if rows else None

    def execute(self, sql, **params):
        if self.kind == "pg":
            self.con.run(sql, **params)
            return self.con.row_count
        cur = self.con.execute(sql, params)
        return cur.rowcount

    def begin(self):
        self.execute("BEGIN")

    def commit(self):
        self.execute("COMMIT")

    def rollback(self):
        try:
            self.execute("ROLLBACK")
        except Exception:
            pass

    def close(self):
        try:
            self.con.close()
        except Exception:
            pass

    def ensure_schema(self):
        global _schema_ready
        if _schema_ready:
            return
        for stmt in SCHEMA:
            self.execute(stmt)
        _schema_ready = True

    # -- settings -----------------------------------------------------------
    def raw_settings(self):
        out = {}
        for row in self.query("SELECT key, value FROM settings"):
            try:
                out[row["key"]] = json.loads(row["value"])
            except Exception:
                out[row["key"]] = row["value"]
        return out

    def set_setting(self, key, value):
        encoded = json.dumps(value)
        updated = self.execute("UPDATE settings SET value = :value WHERE key = :key", key=key, value=encoded)
        if not updated:
            self.execute("INSERT INTO settings (key, value) VALUES (:key, :value)", key=key, value=encoded)

    def settings(self):
        """Public settings merged over defaults (secrets removed)."""
        raw = self.raw_settings()
        merged = json.loads(json.dumps(DEFAULT_SETTINGS))
        for key, value in raw.items():
            if key in SECRET_KEYS:
                continue
            if isinstance(value, dict) and isinstance(merged.get(key), dict):
                merged[key].update(value)
            else:
                merged[key] = value
        return merged

    def secret(self):
        env = os.environ.get("APP_SECRET")
        if env:
            return env
        raw = self.raw_settings()
        if raw.get("secret"):
            return raw["secret"]
        value = secrets.token_hex(32)
        self.set_setting("secret", value)
        return value


# -- small helpers ----------------------------------------------------------
def utcnow():
    return datetime.datetime.now(datetime.timezone.utc)


def now_iso():
    return utcnow().replace(microsecond=0, tzinfo=None).isoformat() + "Z"


def new_id():
    return secrets.token_hex(6)


def digits(phone):
    d = re.sub(r"\D", "", phone or "")
    if len(d) == 11 and d.startswith("1"):
        d = d[1:]
    return d


def format_phone(phone):
    d = digits(phone)
    if len(d) == 10:
        return "(%s) %s-%s" % (d[:3], d[3:6], d[6:])
    return phone or ""


def hash_pin(pin):
    salt = secrets.token_hex(8)
    digest = hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), salt.encode("utf-8"), 120000).hex()
    return salt + "$" + digest


def verify_pin(pin, stored):
    if not stored or "$" not in stored:
        return False
    salt, digest = stored.split("$", 1)
    candidate = hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), salt.encode("utf-8"), 120000).hex()
    return hmac.compare_digest(candidate, digest)


def sign_token(secret, role, ttl_seconds):
    expires = int(utcnow().timestamp()) + ttl_seconds
    payload = "%s.%d" % (role, expires)
    sig = hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return payload + "." + sig, expires


def verify_token(secret, token):
    try:
        role, expires, sig = token.split(".")
        payload = "%s.%s" % (role, expires)
        expected = hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return None
        if int(expires) < int(utcnow().timestamp()):
            return None
        return role
    except Exception:
        return None


def age_on(birthdate, on_date):
    """Whole years between an ISO birthdate and an ISO date. None if unknown."""
    try:
        b = datetime.date.fromisoformat(birthdate[:10])
        d = datetime.date.fromisoformat(on_date[:10])
    except Exception:
        return None
    years = d.year - b.year - ((d.month, d.day) < (b.month, b.day))
    return max(years, 0)


def classroom_for(age, classrooms, override=None):
    """First classroom whose max_age covers the child's age; override wins."""
    if override:
        for room in classrooms:
            if room["id"] == override:
                return room
    if age is None:
        return None
    for room in classrooms:
        try:
            if age <= int(room.get("max_age", 99)):
                return room
        except (TypeError, ValueError):
            continue
    return None
