# apps/crystal_custom/crystal_custom/crystal_customizations/dispatch_engine.py
"""
NEXUS DISPATCH ENGINE (Batch 12)

One engine behind BOTH ways a truck trip is recorded:
  * Truck Assignment page -> Dispatch            (sales_order_truck_as.dispatch_and_restart_truck)
  * Crystal Truck Plan form -> Reconcile Dispatch (crystal_truck_plan.reconcile_dispatch)

Rules
  1. Submitted Delivery Notes are the proof of what left the yard. A plan
     row (= one manifest stop) is ONE Delivery Note: its value, weight and
     items are the Delivery Note's, never the Sales Order's (SO 20 units,
     DN 15 units -> the trip carries 15). The Sales Order ids are kept on
     the row so the Delivery Notes can always be found again.
  2. An order without a submitted Delivery Note can't be dispatched.
  3. A Delivery Note sits on one active plan at a time.
  4. Route + distance come from Google (Routes API, ONE request per button
     press, at most 25 stops) or the Hosted engine (FastAPI /calculate-route:
     VROOM order + ORS road geometry). If Google can't be used or fails,
     Hosted is used automatically and the plan records which one ran.
  5. The Google key is a SERVER key, read only here (site_config
     "nexus_google_routes_api_key" or Nexus App Settings -> Google Maps
     Server API Key). It never reaches a browser.

Nothing here commits; the whitelisted callers own the transaction.
"""

import json
from collections import OrderedDict

import frappe
import requests
from frappe import _
from frappe.utils import cint, flt, now_datetime

TRUCK_PLAN = "Crystal Truck Plan"
PLAN_ORDER = "Crystal Truck Plan Order"
PLAN_ITEM = "Crystal Truck Plan Delivery Item"
MANIFEST = "Vehicle Delivery Manifest"
STOP = "In Transit-Delivery Stop"

PROVIDER_GOOGLE = "Google"
PROVIDER_HOSTED = "Hosted"
PROVIDERS = (PROVIDER_GOOGLE, PROVIDER_HOSTED)

SOURCE_TRUCK_ASSIGNMENT = "Truck Assignment"
SOURCE_RECONCILE = "Reconcile Dispatch"

GOOGLE_MAX_STOPS = 25
GOOGLE_ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
GOOGLE_FIELD_MASK = (
	"routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,"
	"routes.optimizedIntermediateWaypointIndex"
)
ROUTE_TIMEOUT_SEC = 25
FIND_LIMIT = 200

PENDING = "Pending"
CLOSED_TRIP_STATES = ("Completed", "Cancelled")

PAGE_MODULE = "crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as"


class RouteError(Exception):
	pass


# ============================================================================
# Small helpers
# ============================================================================
def _unique(values):
	seen, out = set(), []
	for v in values or []:
		v = (str(v).strip() if v is not None else "")
		if v and v not in seen:
			seen.add(v)
			out.append(v)
	return out


def parse_list(value):
	"""JSON list, python list or comma/newline text -> clean unique list."""
	if value in (None, ""):
		return []
	if isinstance(value, str):
		try:
			value = json.loads(value)
		except ValueError:
			value = [p for chunk in value.splitlines() for p in chunk.split(",")]
	if not isinstance(value, (list, tuple)):
		value = [value]
	return _unique(value)


def _plate(value):
	return (value or "").replace(" ", "").upper()


def _esc(value):
	return frappe.utils.escape_html(value if value is not None else "")


def _has(doctype, column):
	try:
		return bool(frappe.db.has_column(doctype, column))
	except Exception:
		return False


def _point(lat, lng, combined=None):
	"""(lat, lng) floats or None. Same parser as the rest of Nexus (no 0,0, no junk)."""
	try:
		from nexus_supply_chain.api import build_coordinate_fields

		fields, point = build_coordinate_fields(lat, lng, combined)
		if fields and point:
			return flt(point[0]), flt(point[1])
		return None
	except Exception:
		la, ln = flt(lat), flt(lng)
		if la and ln and -90 <= la <= 90 and -180 <= ln <= 180:
			return la, ln
		return None


def _pin_fields(lat, lng, combined=None):
	"""Stop pin fields (exact text) for a point, or {}."""
	try:
		from nexus_supply_chain.api import build_coordinate_fields

		fields, point = build_coordinate_fields(lat, lng, combined)
		if fields and point:
			return {"combined_coordinates": fields["custom_combined_coordinates"],
			        "latitude": point[0], "longitude": point[1]}
	except Exception:
		pass
	return {}


def row_sales_orders(row):
	"""All Sales Orders a plan row stands for (the DN may cover several)."""
	listed = parse_list((row.get("sales_orders") if hasattr(row, "get") else None) or "")
	return _unique(([row.get("sales_order")] if row.get("sales_order") else []) + listed)


def plan_sales_orders(plan):
	out = []
	for row in plan.get("orders") or []:
		out.extend(row_sales_orders(row))
	return _unique(out)


def plan_delivery_notes(plan):
	return _unique([r.delivery_note for r in plan.get("orders") or [] if r.get("delivery_note")])


# ============================================================================
# Google key + routing options
# ============================================================================
def google_server_key():
	key = (frappe.conf.get("nexus_google_routes_api_key") or "").strip()
	if key:
		return key
	try:
		from frappe.utils.password import get_decrypted_password

		key = get_decrypted_password("Nexus App Settings", "Nexus App Settings",
		                             "google_maps_server_api_key", raise_exception=False)
	except Exception:
		key = None
	return (key or "").strip()


def routing_options(located_stops):
	"""What the route-engine dialog offers. Google is the default only when one
	request covers the whole trip (key configured, 1..25 located stops)."""
	located = cint(located_stops)
	configured = bool(google_server_key())
	within = located <= GOOGLE_MAX_STOPS
	if not configured:
		reason = _("Google routing isn't set up (Nexus App Settings → Google Maps Server API Key). The hosted engine will be used.")
	elif not within:
		reason = _("{0} located stops: Google optimises at most {1} stops in one request, so the hosted engine is recommended.").format(located, GOOGLE_MAX_STOPS)
	elif located == 0:
		reason = _("No stop has a location yet, so no route can be drawn.")
	else:
		reason = _("Google: 1 request for {0} stops (latest roads). Hosted: free, Nexus server.").format(located)
	google_available = configured and within
	return {
		"google_configured": configured,
		"google_available": google_available,
		"google_max_stops": GOOGLE_MAX_STOPS,
		"located_stops": located,
		"default": PROVIDER_GOOGLE if (google_available and located > 0) else PROVIDER_HOSTED,
		"reason": reason,
	}


# ============================================================================
# Delivery Notes
# ============================================================================
def used_elsewhere(dn_names, plan_name=None):
	"""{delivery_note: plan} for DNs already on another active (draft/submitted) plan."""
	names = _unique(dn_names)
	if not names or not _has(PLAN_ORDER, "delivery_note"):
		return {}
	rows = frappe.db.sql("""
		SELECT o.delivery_note, o.parent
		FROM `tabCrystal Truck Plan Order` o
		JOIN `tabCrystal Truck Plan` p ON p.name = o.parent
		WHERE o.parenttype = 'Crystal Truck Plan'
		  AND p.docstatus < 2
		  AND o.delivery_note IN %(names)s
		  AND o.parent != %(plan)s
	""", {"names": tuple(names), "plan": plan_name or ""}, as_dict=True)
	return {r.delivery_note: r.parent for r in rows}


def delivery_note_summaries(dn_names, plan_name=None):
	"""
	OrderedDict name -> everything the dialogs, the plan rows and the manifest
	stops need from a Delivery Note (input order kept). "problems" lists why a
	DN can't be used; empty means it's good to dispatch.
	"""
	names = _unique(dn_names)
	out = OrderedDict()
	if not names:
		return out

	dn_rows = {r.name: r for r in frappe.db.sql("""
		SELECT name, docstatus, IFNULL(is_return, 0) AS is_return, customer, customer_name, posting_date,
		       IFNULL(grand_total, 0) AS grand_total, IFNULL(net_total, 0) AS net_total,
		       IFNULL(total_net_weight, 0) AS total_net_weight, vehicle_no
		FROM `tabDelivery Note` WHERE name IN %(names)s
	""", {"names": tuple(names)}, as_dict=True)}

	cogs_col = ", IFNULL(custom_total_market_cogs, 0) AS total_cogs" if _has("Delivery Note Item", "custom_total_market_cogs") else ""
	items_by_dn = {}
	for it in frappe.db.sql(f"""
		SELECT parent, idx, item_code, item_name, IFNULL(qty, 0) AS qty, uom, IFNULL(rate, 0) AS rate,
		       IFNULL(amount, 0) AS amount, IFNULL(total_weight, 0) AS total_weight, against_sales_order{cogs_col}
		FROM `tabDelivery Note Item` WHERE parent IN %(names)s ORDER BY parent, idx
	""", {"names": tuple(names)}, as_dict=True):
		items_by_dn.setdefault(it.parent, []).append(it)

	so_names = _unique([it.against_sales_order for its in items_by_dn.values() for it in its if it.against_sales_order])
	so_info = {}
	if so_names:
		region = "custom_delivery_region" if _has("Sales Order", "custom_delivery_region") else "NULL"
		for s in frappe.db.sql(f"""
			SELECT name, {region} AS delivery_region, custom_truck_number, IFNULL(custom_truck_closed, 0) AS truck_closed
			FROM `tabSales Order` WHERE name IN %(names)s
		""" if _has("Sales Order", "custom_truck_number") else f"""
			SELECT name, {region} AS delivery_region, NULL AS custom_truck_number, 0 AS truck_closed
			FROM `tabSales Order` WHERE name IN %(names)s
		""", {"names": tuple(so_names)}, as_dict=True):
			so_info[s.name] = s

	customers = _unique([r.customer for r in dn_rows.values() if r.customer])
	cust = {}
	if customers:
		cols = [c for c in ("custom_latitude", "custom_longitude", "custom_combined_coordinates") if _has("Customer", c)]
		select = ", ".join(["name"] + [f"`{c}`" for c in cols])
		for c in frappe.db.sql(f"SELECT {select} FROM `tabCustomer` WHERE name IN %(names)s",
		                       {"names": tuple(customers)}, as_dict=True):
			cust[c.name] = c

	used = used_elsewhere(names, plan_name)

	for name in names:
		dn = dn_rows.get(name)
		if not dn:
			out[name] = {"name": name, "problems": [_("not found")], "items": [], "sales_orders": [],
			             "has_location": False}
			continue
		items = items_by_dn.get(name, [])
		sos = _unique([it.against_sales_order for it in items if it.against_sales_order])
		c = cust.get(dn.customer) or {}
		pt = _point(c.get("custom_latitude"), c.get("custom_longitude"), c.get("custom_combined_coordinates"))
		weight = flt(dn.total_net_weight) or sum(flt(it.total_weight) for it in items)
		first_so = so_info.get(sos[0]) if sos else None

		problems = []
		if dn.docstatus == 0:
			problems.append(_("not submitted"))
		elif dn.docstatus == 2:
			problems.append(_("cancelled"))
		if cint(dn.is_return):
			problems.append(_("is a return"))
		if not sos:
			problems.append(_("not linked to a Sales Order"))
		if used.get(name):
			problems.append(_("already on {0}").format(used[name]))

		out[name] = {
			"name": name,
			"docstatus": dn.docstatus,
			"customer": dn.customer,
			"customer_name": dn.customer_name or dn.customer,
			"posting_date": str(dn.posting_date) if dn.posting_date else None,
			"vehicle_no": dn.vehicle_no,
			"grand_total": flt(dn.grand_total),
			"net_total": flt(dn.net_total),
			"total_net_weight": weight,
			"sales_orders": sos,
			"sales_order": sos[0] if sos else None,
			"delivery_region": (first_so or {}).get("delivery_region") or "",
			"other_trucks": sorted({so_info[s].custom_truck_number for s in sos
			                        if s in so_info and so_info[s].custom_truck_number
			                        and not cint(so_info[s].truck_closed)}),
			"latitude": c.get("custom_latitude") if pt else None,
			"longitude": c.get("custom_longitude") if pt else None,
			"point": pt,
			"has_location": bool(pt),
			"items": [{
				"item_code": it.item_code, "item_name": it.item_name, "qty": flt(it.qty), "uom": it.uom,
				"rate": flt(it.rate), "amount": flt(it.amount), "total_weight": flt(it.total_weight),
				"sales_order": it.against_sales_order,
			} for it in items],
			"item_count": len(items),
			"used_on": used.get(name),
			"problems": problems,
		}
	return out


def public_summary(s):
	"""A summary without the internal tuple (JSON-safe for the browser)."""
	return {k: v for k, v in s.items() if k != "point"}


def find_delivery_notes(from_date, to_date, vehicle_no, limit=FIND_LIMIT):
	"""Submitted, non-return DNs posted in the window for this vehicle (plate compared without spaces/case)."""
	plate = _plate(vehicle_no)
	if not plate:
		frappe.throw(_("Enter the Vehicle No to search Delivery Notes."), title=_("Vehicle No Required"))
	if not from_date or not to_date:
		frappe.throw(_("Choose the From and To dates."), title=_("Dates Required"))
	return [r[0] for r in frappe.db.sql("""
		SELECT name FROM `tabDelivery Note`
		WHERE docstatus = 1 AND IFNULL(is_return, 0) = 0
		  AND posting_date BETWEEN %(from_date)s AND %(to_date)s
		  AND UPPER(REPLACE(IFNULL(vehicle_no, ''), ' ', '')) = %(plate)s
		ORDER BY posting_date, name
		LIMIT %(limit)s
	""", {"from_date": from_date, "to_date": to_date, "plate": plate, "limit": cint(limit)})]


def resolve_delivery_notes(sales_orders, plan_name=None):
	"""
	Delivery Notes for these Sales Orders (submitted, not returns, not on
	another active plan). Returns (dns, missing_details, by_so).
	One SO may have several DNs (split deliveries): all are taken.
	"""
	sos = _unique(sales_orders)
	if not sos:
		return [], [], {}
	rows = frappe.db.sql("""
		SELECT DISTINCT dni.against_sales_order AS so, dn.name AS dn, dn.posting_date
		FROM `tabDelivery Note Item` dni
		JOIN `tabDelivery Note` dn ON dn.name = dni.parent
		WHERE dn.docstatus = 1 AND IFNULL(dn.is_return, 0) = 0
		  AND dni.against_sales_order IN %(sos)s
		ORDER BY dn.posting_date, dn.name
	""", {"sos": tuple(sos)}, as_dict=True)
	used = used_elsewhere([r.dn for r in rows], plan_name)

	by_so, blocked = {}, {}
	for r in rows:
		if r.dn in used:
			blocked.setdefault(r.so, []).append((r.dn, used[r.dn]))
		else:
			by_so.setdefault(r.so, [])
			if r.dn not in by_so[r.so]:
				by_so[r.so].append(r.dn)

	missing = [so for so in sos if not by_so.get(so)]
	dns = _unique([dn for so in sos for dn in by_so.get(so, [])])
	return dns, missing_details(missing, blocked), by_so


def missing_details(sales_orders, blocked=None):
	"""[{sales_order, customer_name, reason}] for orders that have no usable DN."""
	sos = _unique(sales_orders)
	if not sos:
		return []
	blocked = blocked or {}
	info = {r.name: r for r in frappe.db.sql(
		"SELECT name, customer_name, docstatus FROM `tabSales Order` WHERE name IN %(sos)s",
		{"sos": tuple(sos)}, as_dict=True)}
	out = []
	for so in sos:
		r = info.get(so)
		if not r:
			reason = _("Sales Order not found")
		elif r.docstatus == 0:
			reason = _("Sales Order is not submitted, so it has no Delivery Note")
		elif r.docstatus == 2:
			reason = _("Sales Order is cancelled")
		elif blocked.get(so):
			reason = _("Its Delivery Note(s) are already on another plan: {0}").format(
				", ".join(f"{dn} ({plan})" for dn, plan in blocked[so]))
		else:
			reason = _("No submitted Delivery Note yet")
		out.append({"sales_order": so, "customer_name": (r.customer_name if r else "") or "", "reason": reason})
	return out


def missing_dn_message(missing, truck_number=None):
	rows = "".join(
		f"<tr><td>{_esc(m['sales_order'])}</td><td>{_esc(m['customer_name'])}</td><td>{_esc(m['reason'])}</td></tr>"
		for m in missing
	)
	head = _("Truck {0}: these orders have no submitted Delivery Note, so nothing was dispatched.").format(_esc(truck_number)) \
		if truck_number else _("These orders have no submitted Delivery Note, so nothing was saved.")
	return (f"<p>{head}</p><table class='table table-bordered table-sm small'><thead><tr>"
	        f"<th>{_('Sales Order')}</th><th>{_('Customer')}</th><th>{_('Reason')}</th></tr></thead>"
	        f"<tbody>{rows}</tbody></table>"
	        f"<p class='text-muted small'>{_('Submit the Delivery Note(s) with the Vehicle No, or remove the order from the truck, then try again.')}</p>")


# ============================================================================
# Plan rows
# ============================================================================
def _set_plan_summary(plan):
	rows = plan.get("orders") or []
	plan.order_count = len(rows)
	plan.total_weight = sum(flt(r.total_net_weight) for r in rows)
	plan.total_value = sum(flt(r.grand_total) for r in rows)
	plan.delivery_regions = ", ".join(sorted({r.delivery_region for r in rows if r.delivery_region}))


def apply_delivery_notes_to_plan(plan, summaries):
	"""One plan row per DN + every DN line in Delivered Items."""
	plan.set("orders", [])
	plan.set("delivery_items", [])
	for s in summaries.values():
		plan.append("orders", {
			"sales_order": s["sales_order"],
			"delivery_note": s["name"],
			"sales_orders": "\n".join(s["sales_orders"]),
			"customer": s["customer"],
			"customer_name": s["customer_name"],
			"delivery_region": s["delivery_region"],
			"grand_total": s["grand_total"],
			"total_net_weight": s["total_net_weight"],
			"latitude": str(s["latitude"]) if s["has_location"] else "",
			"longitude": str(s["longitude"]) if s["has_location"] else "",
		})
		for it in s["items"]:
			plan.append("delivery_items", {
				"delivery_note": s["name"],
				"sales_order": it["sales_order"],
				"item_code": it["item_code"],
				"item_name": it["item_name"],
				"qty": it["qty"],
				"uom": it["uom"],
				"rate": it["rate"],
				"amount": it["amount"],
				"total_weight": it["total_weight"],
			})
	_set_plan_summary(plan)


# ============================================================================
# Routing
# ============================================================================
def _factory():
	try:
		get_company_coordinates = frappe.get_attr(f"{PAGE_MODULE}.get_company_coordinates")
		res = get_company_coordinates() or {}
	except Exception:
		frappe.clear_messages()
		return None
	if res.get("status") != "success":
		return None
	return _point(res.get("lat"), res.get("lng"))


def _route_hosted(factory, points):
	from nexus_supply_chain.fastapi_client import fastapi_url, internal_headers

	home = [factory[1], factory[0]]
	coords = [home] + [[p[1], p[0]] for p in points] + [home]
	resp = requests.post(fastapi_url("/calculate-route"), json={"coordinates": coords},
	                     headers=internal_headers(), timeout=ROUTE_TIMEOUT_SEC)
	resp.raise_for_status()
	data = resp.json()
	if not isinstance(data, dict) or data.get("error") or not data.get("features"):
		raise RouteError((data or {}).get("error") if isinstance(data, dict) else "Empty response from the hosted engine.")
	data["provider"] = PROVIDER_HOSTED
	return data


def _decode_polyline(encoded, precision=5):
	"""Google encoded polyline -> [[lng, lat], ...] (GeoJSON order)."""
	coords, index, lat, lng = [], 0, 0, 0
	factor = 10 ** precision
	length = len(encoded or "")
	while index < length:
		for which in (0, 1):
			shift, result = 0, 0
			while True:
				b = ord(encoded[index]) - 63
				index += 1
				result |= (b & 0x1F) << shift
				shift += 5
				if b < 0x20:
					break
			delta = ~(result >> 1) if (result & 1) else (result >> 1)
			if which == 0:
				lat += delta
			else:
				lng += delta
		coords.append([lng / factor, lat / factor])
	return coords


def _route_google(factory, points, key):
	"""ONE Routes API request: yard -> optimised stops -> yard. Returns the same
	GeoJSON shape as the hosted engine (features[0].properties.summary)."""
	def wp(p):
		return {"location": {"latLng": {"latitude": p[0], "longitude": p[1]}}}

	body = {
		"origin": wp(factory),
		"destination": wp(factory),
		"intermediates": [wp(p) for p in points],
		"travelMode": "DRIVE",
		"routingPreference": "TRAFFIC_UNAWARE",
		"optimizeWaypointOrder": len(points) > 1,
		"polylineQuality": "HIGH_QUALITY",
		"polylineEncoding": "ENCODED_POLYLINE",
		"units": "METRIC",
	}
	resp = requests.post(GOOGLE_ROUTES_URL, json=body, timeout=ROUTE_TIMEOUT_SEC, headers={
		"Content-Type": "application/json",
		"X-Goog-Api-Key": key,
		"X-Goog-FieldMask": GOOGLE_FIELD_MASK,
	})
	try:
		data = resp.json()
	except ValueError:
		data = {}
	if resp.status_code != 200:
		msg = ((data or {}).get("error") or {}).get("message") or f"HTTP {resp.status_code}"
		raise RouteError(f"Google Routes: {msg}")
	routes = (data or {}).get("routes") or []
	if not routes:
		raise RouteError("Google Routes returned no route.")
	r = routes[0]
	line = _decode_polyline(((r.get("polyline") or {}).get("encodedPolyline")) or "")
	if len(line) < 2:
		raise RouteError("Google Routes returned an empty line.")
	duration = flt(str(r.get("duration") or "0s").rstrip("s"))
	n = len(points)
	order = r.get("optimizedIntermediateWaypointIndex") or []
	if sorted(order) != list(range(n)):
		order = list(range(n))
	return {
		"type": "FeatureCollection",
		"features": [{
			"type": "Feature",
			"geometry": {"type": "LineString", "coordinates": line},
			"properties": {"summary": {"distance": flt(r.get("distanceMeters")), "duration": duration},
			               "provider": PROVIDER_GOOGLE},
		}],
		"waypoint_order": order,
		"provider": PROVIDER_GOOGLE,
	}


def compute_route(plan, provider=None):
	"""
	Routes the plan's located rows (yard -> stops -> yard), REORDERS the rows
	to the route order (unlocated rows last) and returns the result.
	"""
	result = {"distance_km": None, "duration_s": None, "geojson": None, "provider": None,
	          "warnings": [], "unlocated": []}
	rows = list(plan.get("orders") or [])
	located, unlocated = [], []
	for row in rows:
		pt = _point(row.get("latitude"), row.get("longitude"))
		(located if pt else unlocated).append((row, pt))
	result["unlocated"] = [r.customer_name or r.delivery_note or r.sales_order for r, _p in unlocated]
	if unlocated:
		result["warnings"].append(_("{0} stop(s) have no customer location and are left out of the route: {1}").format(
			len(unlocated), ", ".join(result["unlocated"][:10])))

	factory = _factory()
	if not factory:
		result["warnings"].append(_("The company has no GPS coordinates (Company → custom_latitude / custom_longitude), so no route was computed."))
		return result
	if not located:
		result["warnings"].append(_("No stop has a location, so no route was computed."))
		return result

	options = routing_options(len(located))
	provider = provider if provider in PROVIDERS else options["default"]
	if provider == PROVIDER_GOOGLE and not options["google_available"]:
		result["warnings"].append(options["reason"])
		provider = PROVIDER_HOSTED

	points = [p for _r, p in located]
	data = None
	if provider == PROVIDER_GOOGLE:
		try:
			data = _route_google(factory, points, google_server_key())
		except Exception as e:
			frappe.log_error(title="Nexus Dispatch: Google route failed",
			                 message=f"Plan {plan.name}: {e}\n{frappe.get_traceback()}")
			result["warnings"].append(_("Google routing failed ({0}); the hosted engine was used.").format(str(e)[:160]))
			provider = PROVIDER_HOSTED
	if data is None:
		try:
			data = _route_hosted(factory, points)
		except Exception as e:
			frappe.log_error(title="Nexus Dispatch: hosted route failed",
			                 message=f"Plan {plan.name}: {e}\n{frappe.get_traceback()}")
			result["warnings"].append(_("The hosted routing engine failed ({0}); no route was saved.").format(str(e)[:160]))
			return result

	order = data.get("waypoint_order")
	if not isinstance(order, list) or sorted(order) != list(range(len(located))):
		order = list(range(len(located)))
	ordered = [located[i][0] for i in order] + [r for r, _p in unlocated]
	plan.set("orders", ordered)
	for i, row in enumerate(ordered, 1):
		row.idx = i

	position = {r.delivery_note: i for i, r in enumerate(ordered) if r.get("delivery_note")}
	items = sorted(plan.get("delivery_items") or [], key=lambda it: (position.get(it.delivery_note, 10 ** 6), it.idx or 0))
	plan.set("delivery_items", items)
	for i, it in enumerate(items, 1):
		it.idx = i

	summary = ((data.get("features") or [{}])[0].get("properties") or {}).get("summary") or {}
	result.update({
		"distance_km": round(flt(summary.get("distance")) / 1000.0, 3),
		"duration_s": cint(flt(summary.get("duration"))),
		"geojson": json.dumps(data, separators=(",", ":")),
		"provider": provider,
	})
	return result


# ============================================================================
# Margin (from the Delivery Notes = what was actually delivered)
# ============================================================================
def compute_margin(plan, fuel_cost):
	"""
	Total Order Value  = sum of DN grand totals (incl. VAT)
	Revenue excl. VAT  = sum of DN net totals
	COGS               = DN line snapshot (custom_total_market_cogs, set on DN
	                     submit); a line without it is exploded from its BOM now
	Narrowed profit    = revenue excl. VAT - COGS - estimated fuel
	Narrowed margin %  = narrowed profit / revenue excl. VAT
	"""
	dns = plan_delivery_notes(plan)
	out = {"total_order_value": 0.0, "revenue_excl_vat": 0.0, "total_theoretical_cost": 0.0,
	       "narrowed_gross_profit": 0.0, "narrowed_gross_margin_percentage": 0.0, "zero_cost_items": []}
	if not dns:
		return out
	t = frappe.db.sql("""
		SELECT IFNULL(SUM(grand_total), 0), IFNULL(SUM(net_total), 0)
		FROM `tabDelivery Note` WHERE name IN %(dns)s
	""", {"dns": tuple(dns)})[0]
	total, revenue = flt(t[0]), flt(t[1])

	has_cogs = _has("Delivery Note Item", "custom_total_market_cogs")
	lines = frappe.db.sql(f"""
		SELECT item_code, IFNULL(qty, 0) AS qty, {'IFNULL(custom_total_market_cogs, 0)' if has_cogs else '0'} AS cogs
		FROM `tabDelivery Note Item` WHERE parent IN %(dns)s
	""", {"dns": tuple(dns)}, as_dict=True)

	cogs, engine, unit_cache, zero = 0.0, None, {}, set()
	for ln in lines:
		value = flt(ln.cogs)
		if value <= 0 and flt(ln.qty) > 0:
			if ln.item_code not in unit_cache:
				unit = 0.0
				try:
					if engine is None:
						from nexus_supply_chain.utils.bom_exploder import FastBOMExploder

						engine = FastBOMExploder()
					unit = flt(engine.explode(ln.item_code)[0])
				except Exception:
					unit = 0.0
				unit_cache[ln.item_code] = unit
			value = unit_cache[ln.item_code] * flt(ln.qty)
			if value <= 0:
				zero.add(ln.item_code)
		cogs += value

	profit = revenue - cogs - flt(fuel_cost)
	out.update({
		"total_order_value": round(total, 2),
		"revenue_excl_vat": round(revenue, 2),
		"total_theoretical_cost": round(cogs, 2),
		"narrowed_gross_profit": round(profit, 2),
		"narrowed_gross_margin_percentage": round((profit / revenue * 100.0) if revenue else 0.0, 2),
		"zero_cost_items": sorted(zero),
	})
	return out


def _profitability_threshold():
	try:
		return flt(frappe.db.get_single_value("Crystal Fleet Settings", "narrowed_margin_profitability_threshold")) or 33.0
	except Exception:
		return 33.0


# ============================================================================
# The dispatch itself (no save, no commit)
# ============================================================================
def build_dispatch(plan, dn_names, provider=None, source=SOURCE_TRUCK_ASSIGNMENT):
	summaries = delivery_note_summaries(dn_names, None if plan.is_new() else plan.name)
	if not summaries:
		frappe.throw(_("Select at least one Delivery Note."), title=_("Nothing to Dispatch"))
	bad = {n: s["problems"] for n, s in summaries.items() if s["problems"]}
	if bad:
		rows = "".join(f"<li><b>{_esc(n)}</b>: {_esc(', '.join(p))}</li>" for n, p in bad.items())
		frappe.throw(_("These Delivery Notes can't be used:") + f"<ul>{rows}</ul>",
		             title=_("Delivery Notes Can't Be Used"))

	apply_delivery_notes_to_plan(plan, summaries)
	route = compute_route(plan, provider)
	warnings = list(route["warnings"])

	fuel_litres = fuel_cost = 0.0
	if route["distance_km"] is not None:
		if plan.get("capacity_kg"):
			try:
				economics = frappe.get_attr(f"{PAGE_MODULE}.get_vehicle_routing_economics")(
					distance_km=route["distance_km"], vehicle_type=plan.capacity_kg)
				if economics.get("status") == "success":
					fuel_litres = flt(economics.get("total_litres_required"))
					fuel_cost = flt(economics.get("estimated_fuel_cost"))
				else:
					warnings.append(_("Fuel not estimated: {0}").format(economics.get("message")))
			except Exception as e:
				frappe.log_error(title="Nexus Dispatch: fuel estimate failed", message=f"{plan.name}: {e}")
				warnings.append(_("Fuel not estimated."))
		else:
			warnings.append(_("Fuel not estimated: set the Vehicle Type (Capacity) on the plan."))

	margin = compute_margin(plan, fuel_cost)
	if margin["zero_cost_items"]:
		warnings.append(_("No BOM cost for: {0} (counted as 0).").format(", ".join(margin["zero_cost_items"][:10])))

	plan.approximate_total_distance_km = route["distance_km"] or 0.0
	plan.approximate_trip_duration = route["duration_s"] or 0
	plan.approximate_fuel_consumption_ltrs = fuel_litres
	plan.approximate_fuel_cost = fuel_cost
	plan.route_geojson = route["geojson"] or ""
	plan.total_order_value = margin["total_order_value"]
	plan.total_theoretical_cost = margin["total_theoretical_cost"]
	plan.narrowed_gross_profit = margin["narrowed_gross_profit"]
	plan.narrowed_gross_margin_percentage = margin["narrowed_gross_margin_percentage"]
	plan.profitability_status = "Profitable" if margin["narrowed_gross_margin_percentage"] >= _profitability_threshold() else "Loss"

	now = now_datetime()
	plan.route_provider = route["provider"] or ""
	plan.route_computed_at = now if route["provider"] else None
	plan.dispatch_source = source
	plan.dispatched_by = frappe.session.user
	plan.dispatched_at = now
	if source == SOURCE_RECONCILE:
		plan.reconcile_count = cint(plan.get("reconcile_count")) + 1

	return {
		"route_provider": route["provider"],
		"distance_km": route["distance_km"],
		"duration_s": route["duration_s"],
		"unlocated": route["unlocated"],
		"stop_count": len(plan.orders),
		"fuel_cost": fuel_cost,
		"margin": margin,
		"warnings": warnings,
	}


def sync_sales_orders(plan, previous_sales_orders=None):
	"""
	Dispatched trip -> its Sales Orders carry this truck and are closed on the
	Truck Assignment page. Orders taken off the trip go back to "awaiting"
	(only if they still point at this truck).
	"""
	if not (_has("Sales Order", "custom_truck_number") and _has("Sales Order", "custom_truck_closed")):
		return {"closed": [], "released": []}
	current = plan_sales_orders(plan)
	released = [so for so in _unique(previous_sales_orders) if so not in set(current)]
	if current:
		frappe.db.sql("""
			UPDATE `tabSales Order` SET custom_truck_number = %(truck)s, custom_truck_closed = 1
			WHERE name IN %(names)s
		""", {"truck": plan.truck_number or "", "names": tuple(current)})
	if released:
		# Same reset as the page's set_truck_number: back to "awaiting".
		reset_dispatched = ", custom_truck_dispatched = 0" if _has("Sales Order", "custom_truck_dispatched") else ""
		frappe.db.sql(f"""
			UPDATE `tabSales Order` SET custom_truck_number = '', custom_truck_closed = 0{reset_dispatched}
			WHERE name IN %(names)s AND IFNULL(custom_truck_number, '') = %(truck)s
		""", {"truck": plan.truck_number or "", "names": tuple(released)})
	return {"closed": current, "released": released}


# ============================================================================
# Manifest
# ============================================================================
def stop_fields(row):
	"""Stop row values for one plan row (DN rows carry the DN id and DN value)."""
	from nexus_supply_chain.driver_api import build_stop_fields

	stop = build_stop_fields(row.sales_order) if row.get("sales_order") else {}
	if not stop:
		stop = {"sales_order": row.get("sales_order"), "customer_id": row.get("customer"),
		        "customer": row.get("customer_name")}
	if row.get("customer_name"):
		stop["customer"] = row.customer_name
	if row.get("customer") and not stop.get("customer_id"):
		stop["customer_id"] = row.customer
	if row.get("delivery_note"):
		stop["grand_total"] = flt(row.grand_total)
		if _has(STOP, "delivery_note_id"):
			stop["delivery_note_id"] = row.delivery_note
	if not stop.get("combined_coordinates"):
		stop.update(_pin_fields(row.get("latitude"), row.get("longitude")))
	stop["weight_kg"] = flt(row.get("total_net_weight"))
	stop["delivery_status"] = PENDING
	return stop


def _stops(manifest):
	cols = ["name", "idx", "sales_order", "customer", "delivery_status"]
	if _has(STOP, "delivery_note_id"):
		cols.append("delivery_note_id")
	return frappe.get_all(STOP, filters={"parent": manifest, "parenttype": MANIFEST}, fields=cols, order_by="idx asc")


def match_stops(stops, rows):
	"""
	Pairs plan rows ({delivery_note, sales_orders}) with existing stops:
	by DN id first, then (old SO-based stops) by Sales Order.
	Returns (pairs [(row, stop|None)], unmatched_stops).
	"""
	by_dn = {s.get("delivery_note_id"): s for s in stops if s.get("delivery_note_id")}
	legacy = [s for s in stops if not s.get("delivery_note_id")]
	used, pairs = set(), []
	for row in rows:
		stop = by_dn.get(row.get("delivery_note")) if row.get("delivery_note") else None
		if stop and stop.name in used:
			stop = None
		if not stop:
			sos = set(row.get("sales_orders") or [])
			stop = next((s for s in legacy if s.name not in used and s.sales_order in sos), None)
		if stop:
			used.add(stop.name)
		pairs.append((row, stop))
	return pairs, [s for s in stops if s.name not in used]


def manifest_for_plan(plan_name):
	name = frappe.db.get_value(MANIFEST, {"truck_plan": plan_name, "docstatus": ["<", 2]}, "name")
	if not name:
		return None
	return frappe.db.get_value(MANIFEST, name, ["name", "docstatus", "trip_status"], as_dict=True)


def manifest_impact(plan_name, rows):
	"""Read-only preview of what syncing would do to the plan's manifest."""
	m = manifest_for_plan(plan_name)
	if not m:
		return {"manifest": None, "action": "none"}
	info = {"manifest": m.name, "docstatus": m.docstatus, "trip_status": m.trip_status or "Manifested"}
	if m.docstatus == 0:
		return {**info, "action": "rebuild", "add": len(rows), "remove": 0, "blocked": []}
	if (m.trip_status or "") in CLOSED_TRIP_STATES:
		return {**info, "action": "skip", "add": 0, "remove": 0, "blocked": []}
	pairs, unmatched = match_stops(_stops(m.name), rows)
	blocked = [{"stop": s.name, "label": s.customer or s.sales_order or s.name, "status": s.delivery_status}
	           for s in unmatched if (s.delivery_status or PENDING) != PENDING]
	return {**info, "action": "live",
	        "add": sum(1 for _r, s in pairs if not s),
	        "remove": sum(1 for s in unmatched if (s.delivery_status or PENDING) == PENDING),
	        "blocked": blocked}


def _row_view(row):
	return frappe._dict(delivery_note=row.get("delivery_note"), sales_orders=row_sales_orders(row))


def _manifest_header(plan, route_result=None):
	values = {
		"route_geojson": plan.route_geojson,
		"approximate_total_distance_km": flt(plan.approximate_total_distance_km),
		"approximate_fuel_consumption_ltrs": flt(plan.approximate_fuel_consumption_ltrs),
		"approximate_fuel_cost": flt(plan.approximate_fuel_cost),
		"gross_margin": flt(plan.narrowed_gross_margin_percentage),
		"profitability_status": plan.profitability_status,
	}
	if route_result is not None:
		values["approximate_drive_time_min"] = round(cint(route_result.get("duration_s")) / 60.0, 1)
		values["stops_without_location"] = len(route_result.get("unlocated") or [])
		values["route_recomputed_at"] = now_datetime()
	return values


def sync_manifest(plan, route_result=None):
	"""
	Brings the plan's Vehicle Delivery Manifest in line with the plan:
	  draft manifest        -> stops rebuilt from the plan
	  Ready/Dispatched/Ret. -> stops added (new DNs), PENDING stops removed,
	                           old SO stops linked to their DN, order updated;
	                           confirmed stops are never touched
	  Completed/Cancelled   -> left alone (history)
	Then route, distance, fuel and margin are copied and the drivers' apps refreshed.
	"""
	m = manifest_for_plan(plan.name)
	if not m:
		return {"manifest": None, "action": "none", "message": _("No Delivery Manifest yet: use Nexus Actions → Create Delivery Manifest.")}
	frappe.db.sql("SELECT name FROM `tabVehicle Delivery Manifest` WHERE name = %s FOR UPDATE", m.name)

	if m.docstatus == 0:
		doc = frappe.get_doc(MANIFEST, m.name)
		doc.set("stops", [stop_fields(r) for r in plan.orders])
		header = _manifest_header(plan)
		header["profit_loss"] = flt(plan.narrowed_gross_profit)
		for k, v in header.items():
			if doc.meta.has_field(k):
				doc.set(k, v)
		doc.save(ignore_permissions=True)
		return {"manifest": m.name, "action": "rebuilt", "added": len(plan.orders), "removed": 0, "kept": []}

	if (m.trip_status or "") in CLOSED_TRIP_STATES:
		return {"manifest": m.name, "action": "skipped",
		        "message": _("Manifest {0} is {1}: its stops were not changed.").format(m.name, m.trip_status)}

	from nexus_supply_chain.driver_api import push_manifest_refresh, recalculate_manifest_totals

	has_dn = _has(STOP, "delivery_note_id")
	stops = _stops(m.name)
	pairs, unmatched = match_stops(stops, [_row_view(r) for r in plan.orders])
	order, added = [], 0
	for (view, stop), row in zip(pairs, plan.orders):
		if stop:
			update = {}
			if has_dn and row.get("delivery_note") and stop.get("delivery_note_id") != row.delivery_note:
				update["delivery_note_id"] = row.delivery_note
			if (stop.delivery_status or PENDING) == PENDING and row.get("delivery_note"):
				update.update({"grand_total": flt(row.grand_total), "weight_kg": flt(row.total_net_weight)})
			if update:
				frappe.db.set_value(STOP, stop.name, update, update_modified=False)
			order.append(stop.name)
		else:
			child = frappe.get_doc({"doctype": STOP, "parent": m.name, "parenttype": MANIFEST,
			                        "parentfield": "stops", "docstatus": 1, "idx": 0, **stop_fields(row)})
			child.db_insert()
			order.append(child.name)
			added += 1

	removed, kept = [], []
	for s in unmatched:
		if (s.delivery_status or PENDING) == PENDING:
			frappe.db.delete(STOP, {"name": s.name})
			removed.append(s.customer or s.sales_order or s.name)
		else:
			kept.append(s.name)

	for i, name in enumerate(kept + order, 1):
		frappe.db.set_value(STOP, name, "idx", i, update_modified=False)

	header = {k: v for k, v in _manifest_header(plan, route_result).items() if _has(MANIFEST, k)}
	if _has(MANIFEST, "original_planned_distance_km") and not flt(
			frappe.db.get_value(MANIFEST, m.name, "original_planned_distance_km")):
		header["original_planned_distance_km"] = flt(plan.approximate_total_distance_km)
	frappe.db.set_value(MANIFEST, m.name, header)
	recalculate_manifest_totals(m.name)

	frappe.get_doc({
		"doctype": "Comment", "comment_type": "Info", "reference_doctype": MANIFEST, "reference_name": m.name,
		"content": (f"🔁 Stops reconciled from Truck Plan <b>{_esc(plan.name)}</b> by <b>{_esc(frappe.session.user)}</b>: "
		            f"{added} added, {len(removed)} removed, {len(kept)} confirmed kept. "
		            f"Route: {_esc(plan.route_provider or 'none')}, {flt(plan.approximate_total_distance_km):,.1f} km."),
	}).insert(ignore_permissions=True)
	push_manifest_refresh([m.name], reason="stops_reconciled")
	return {"manifest": m.name, "action": "updated", "added": added, "removed": len(removed), "kept": kept}
