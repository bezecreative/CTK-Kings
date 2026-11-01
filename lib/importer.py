"""CSV import: parse a people export and propose households.

Works with flat member exports (one row per person) such as the church
management "group export": people are joined into one household when they
share a phone number, share a last name and street address, or when the
export has a household column. Children usually appear with a parent's
email/phone copied onto their row, so that is the main clue for roles.
Everything here is a *proposal*: the admin reviews it before importing.
"""
import csv
import io
import re
from collections import Counter, defaultdict

from .db import age_on, digits

COLUMN_CANDIDATES = {
    "external_id": ["individual id", "person id", "member id", "people id", "id"],
    "first_name": ["first name", "first", "given name", "firstname"],
    "last_name": ["last name", "last", "surname", "family name", "lastname"],
    "email": ["email", "e-mail", "email address", "primary email"],
    "mobile": ["mobile phone", "mobile", "cell", "cell phone", "phone", "primary phone"],
    "home": ["home phone", "home"],
    "work": ["work phone", "work"],
    "street": ["street", "address", "address 1", "street address", "address line 1"],
    "birthdate": ["birthdate", "birth date", "dob", "date of birth", "birthday"],
    "grade": ["grade"],
    "allergies": ["allergies", "allergy", "medical", "medical notes"],
    "notes": ["notes", "note", "comments"],
    "household": ["household", "household name", "household id", "family id"],
    "status": ["status", "membership", "member status"],
}

HONORIFICS = re.compile(r"^(pastor|rev\.?|dr\.?|mr\.?|mrs\.?|ms\.?|miss)\s+", re.I)
ORG_LAST_NAMES = {"org", "organization", "inc", "llc", "church", "ministries", "ministry", "seminary", "diocese"}
ORG_FIRST_NAME = re.compile(r"\b(church|seminary|diocese|ministr\w*|anonymous|payer|foundation|school|university)\b", re.I)


def parse_csv(text):
    text = text.lstrip("﻿")
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    reader = csv.reader(io.StringIO(text), dialect)
    rows = [r for r in reader if any((cell or "").strip() for cell in r)]
    if not rows:
        return [], []
    headers = [h.strip() for h in rows[0]]
    records = []
    for r in rows[1:]:
        rec = {}
        for i, h in enumerate(headers):
            rec[h] = (r[i].strip() if i < len(r) and r[i] is not None else "")
        records.append(rec)
    return headers, records


def detect_mapping(headers):
    lowered = {h.lower().strip(): h for h in headers}
    mapping = {}
    for field, candidates in COLUMN_CANDIDATES.items():
        for cand in candidates:
            if cand in lowered:
                mapping[field] = lowered[cand]
                break
    return mapping


def _clean_first(name):
    cleaned = HONORIFICS.sub("", name or "").strip()
    return cleaned or (name or "").strip()


def _norm_date(value):
    value = (value or "").strip()
    if not value:
        return ""
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", value)
    if m:
        return "%s-%02d-%02d" % (m.group(1), int(m.group(2)), int(m.group(3)))
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2,4})", value)
    if m:
        year = int(m.group(3))
        if year < 100:
            year += 2000 if year < 30 else 1900
        return "%04d-%02d-%02d" % (year, int(m.group(1)), int(m.group(2)))
    return ""


def _looks_like_org(p):
    return p["last_name"].lower() in ORG_LAST_NAMES or bool(ORG_FIRST_NAME.search(p["first_name"]))


def _sort_key(p):
    """Earlier database entries are usually the parents."""
    ext = p.get("external_id") or ""
    return (0, int(ext)) if ext.isdigit() else (1, p["row"])


class UnionFind:
    def __init__(self, n):
        self.parent = list(range(n))

    def find(self, i):
        while self.parent[i] != i:
            self.parent[i] = self.parent[self.parent[i]]
            i = self.parent[i]
        return i

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


def _people_from(records, mapping):
    get = lambda rec, field: (rec.get(mapping[field], "") if field in mapping else "")
    people = []
    for i, rec in enumerate(records):
        first = _clean_first(get(rec, "first_name"))
        last = (get(rec, "last_name") or "").strip()
        if not first and not last:
            continue
        phones = [digits(get(rec, c)) for c in ("mobile", "home", "work")]
        phones = list(dict.fromkeys(p for p in phones if len(p) >= 7))
        people.append({
            "row": i + 2,
            "external_id": (get(rec, "external_id") or "").strip(),
            "first_name": first,
            "last_name": last,
            "email": (get(rec, "email") or "").strip().lower(),
            "phones": phones,
            "phone": phones[0] if phones else "",
            "street": re.sub(r"\s+", " ", (get(rec, "street") or "").strip().lower()),
            "birthdate": _norm_date(get(rec, "birthdate")),
            "grade": (get(rec, "grade") or "").strip(),
            "allergies": (get(rec, "allergies") or "").strip(),
            "notes": (get(rec, "notes") or "").strip(),
            "household": (get(rec, "household") or "").strip(),
        })
    return people


def _cluster(people):
    uf = UnionFind(len(people))
    by_phone, by_addr, by_household, by_email = defaultdict(list), defaultdict(list), defaultdict(list), defaultdict(list)
    for idx, p in enumerate(people):
        for ph in p["phones"]:
            by_phone[ph].append(idx)
        if p["street"] and p["last_name"]:
            by_addr[(p["last_name"].lower(), p["street"])].append(idx)
        if p["household"]:
            by_household[p["household"].lower()].append(idx)
        if p["email"]:
            by_email[p["email"]].append(idx)
    # A shared email joins people too (a child often carries a parent's email), unless it looks
    # like a generic address used by many unrelated rows.
    email_groups = [g for g in by_email.values() if 1 < len(g) <= 6]
    for group in list(by_phone.values()) + list(by_addr.values()) + list(by_household.values()) + email_groups:
        for idx in group[1:]:
            uf.union(group[0], idx)

    # People with no phone/email/address: attach them by last name when that is unambiguous,
    # otherwise keep them together as their own household flagged for review.
    review = {}
    roots_by_last = defaultdict(set)
    contactless = defaultdict(list)
    for idx, p in enumerate(people):
        has_contact = p["phones"] or p["email"] or p["street"] or p["household"]
        if has_contact:
            roots_by_last[p["last_name"].lower()].add(uf.find(idx))
        elif p["last_name"]:
            contactless[p["last_name"].lower()].append(idx)
    for last, idxs in contactless.items():
        roots = roots_by_last.get(last, set())
        if len(roots) == 1:
            root = next(iter(roots))
            for i in idxs:
                uf.union(root, i)
            review[uf.find(root)] = "some members were matched by last name only"
        else:
            for i in idxs[1:]:
                uf.union(idxs[0], i)
            if len(idxs) > 1 or roots:
                review[uf.find(idxs[0])] = "no phone or email on file; grouped by last name only"

    clusters = defaultdict(list)
    for idx in range(len(people)):
        clusters[uf.find(idx)].append(idx)
    return [(members, review.get(root)) for root, members in clusters.items()]


def _merge_duplicates(members):
    merged = {}
    for p in members:
        key = (p["first_name"].lower(), p["last_name"].lower())
        if key in merged:
            keep = merged[key]
            keep["email"] = keep["email"] or p["email"]
            keep["phones"] = list(dict.fromkeys(keep["phones"] + p["phones"]))
            keep["phone"] = keep["phones"][0] if keep["phones"] else ""
            keep["birthdate"] = keep["birthdate"] or p["birthdate"]
            keep["external_id"] = keep["external_id"] or p["external_id"]
            keep["duplicates"] = keep.get("duplicates", 0) + 1
        else:
            merged[key] = dict(p)
    return list(merged.values())


def _guess_roles(members, today):
    members.sort(key=_sort_key)
    email_count = Counter(m["email"] for m in members if m["email"])
    anyone_has_contact = any(m["phones"] or m["email"] for m in members)
    first_by_email = {}
    undecided_shared = []

    for m in members:
        m["age"] = age_on(m["birthdate"], today) if m["birthdate"] else None
        m["role"] = None
        m["hint"] = ""
        if m["age"] is not None:
            m["role"] = "child" if m["age"] < 18 else "adult"
            m["hint"] = "age %d" % m["age"]
        elif m["grade"]:
            m["role"], m["hint"] = "child", "grade %s" % m["grade"]
        elif m["email"] and email_count[m["email"]] == 1:
            m["role"], m["hint"] = "adult", "own email"
        elif m["email"]:
            local = re.sub(r"[^a-z]", "", m["email"].split("@")[0].lower())
            first = re.sub(r"[^a-z]", "", m["first_name"].lower())
            owner = first_by_email.setdefault(m["email"], m)
            if first and len(first) >= 3 and first in local:
                m["role"], m["hint"] = "adult", "name matches the email"
            else:
                undecided_shared.append(m)
        elif m["phones"] and anyone_has_contact and len(members) > 1:
            with_email = [x for x in members if x["email"] and x is not m]
            if with_email:
                m["role"], m["hint"] = "child", "shares a phone with %s, no email" % with_email[0]["first_name"]
            else:
                undecided_shared.append(m)
        elif len(members) == 1:
            m["role"], m["hint"] = "adult", "only person on this record"
        elif anyone_has_contact:
            m["role"], m["hint"] = "child", "no contact info of their own"
        else:
            undecided_shared.append(m)

    # Shared email / phone with no obvious owner: the earliest record is the adult.
    groups = defaultdict(list)
    for m in undecided_shared:
        groups[m["email"] or (m["phones"][0] if m["phones"] else "none")].append(m)
    for key, group in groups.items():
        owner_known = any(x["role"] == "adult" and (x["email"] == key or key in x["phones"]) for x in members)
        for i, m in enumerate(group):
            if i == 0 and not owner_known:
                m["role"], m["hint"] = "adult", "first record for this contact info"
            else:
                m["role"] = "child"
                m["hint"] = "shares contact info with %s" % (group[0]["first_name"] if not owner_known else "a parent")
    return any(group for group in groups.values())


def propose_households(records, mapping, today):
    """Return (households, stats); each household is ready for review."""
    people = _people_from(records, mapping)
    households = []
    for idxs, review in _cluster(people):
        members = _merge_duplicates([people[i] for i in idxs])
        guessed = _guess_roles(members, today)
        reasons = [review] if review else []
        if guessed and not review:
            reasons.append("could not tell who is the parent; please check roles")
        adults = [p for p in members if p["role"] == "adult"]
        namers = adults or members
        last_names = Counter(p["last_name"] for p in namers if p["last_name"])
        if members[0]["household"] and not members[0]["household"].isdigit():
            name = members[0]["household"]
        elif len(last_names) >= 2:
            name = " / ".join(n for n, _ in last_names.most_common(2))
        elif last_names:
            name = last_names.most_common(1)[0][0] + " Family"
        else:
            name = members[0]["first_name"] + " Family"
        phone = next((p["phone"] for p in namers if p["phone"]), "") or next((p["phone"] for p in members if p["phone"]), "")
        email = next((p["email"] for p in namers if p["email"]), "")
        skip = all(_looks_like_org(p) for p in members)
        if skip:
            reasons = ["looks like an organization, not a family"]
        households.append({
            "name": name,
            "phone": phone,
            "email": email,
            "skip": skip,
            "review": bool(reasons) and not skip,
            "reason": "; ".join(reasons),
            "members": [{
                "external_id": p["external_id"],
                "first_name": p["first_name"],
                "last_name": p["last_name"],
                "role": p["role"],
                "hint": p["hint"],
                "phone": p["phone"],
                "email": p["email"],
                "birthdate": p["birthdate"],
                "allergies": p["allergies"],
                "notes": p["notes"],
                "row": p["row"],
            } for p in sorted(members, key=lambda x: (x["role"] != "adult", _sort_key(x)))],
        })

    households.sort(key=lambda h: (h["skip"], not h["review"], h["name"].lower()))
    stats = {
        "rows": len(records),
        "people": sum(len(h["members"]) for h in households),
        "households": len(households),
        "adults": sum(1 for h in households for m in h["members"] if m["role"] == "adult"),
        "children": sum(1 for h in households for m in h["members"] if m["role"] == "child"),
        "review": sum(1 for h in households if h["review"]),
        "skipped": sum(1 for h in households if h["skip"]),
    }
    return households, stats
