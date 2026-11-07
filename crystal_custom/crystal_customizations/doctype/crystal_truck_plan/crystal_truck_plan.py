import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt, getdate


class CrystalTruckPlan(Document):
    def before_save(self):
        self.order_count = len(self.orders)
        self.total_weight = sum(row.total_net_weight or 0 for row in self.orders)
        self.total_value = sum(row.grand_total or 0 for row in self.orders)
        regions = sorted({row.delivery_region for row in self.orders if row.delivery_region})
        self.delivery_regions = ', '.join(regions)


def _match_vehicle(truck_number):
    """Vehicle In Transit whose plate matches the plan's truck number
    (spaces and case ignored). None when there's no single clear match,
    so the dispatcher picks the vehicle instead of the wrong one being set."""
    plate = (truck_number or "").replace(" ", "").upper()
    if not plate:
        return None
    if frappe.db.exists("Vehicle In Transit", truck_number):
        return truck_number
    if not frappe.db.has_column("Vehicle In Transit", "vehicle_plate"):
        return None
    matches = frappe.db.sql("""
        SELECT name FROM `tabVehicle In Transit`
        WHERE UPPER(REPLACE(IFNULL(vehicle_plate, ''), ' ', '')) = %s
        LIMIT 2
    """, (plate,))
    return matches[0][0] if len(matches) == 1 else None


@frappe.whitelist()
def make_delivery_manifest(source_name):
    """
    Create a Vehicle Delivery Manifest (draft) from a submitted Crystal Truck
    Plan. Stops keep the plan's order (already road-optimised by Dispatch).

    Each stop is filled by nexus_supply_chain.driver_api.build_stop_fields,
    the same builder the manifest controller uses:
      * customer_id (the Customer record) and customer (its name),
      * customer phone,
      * the customer's pin as exact "lat,lng" text via the shared
        coordinate builder (no float rounding, no 0,0 placeholders).
    The vehicle is matched from the plan's truck number; the driver then
    comes from that vehicle's current driver.

    Batch 12: a row that came from a Delivery Note becomes a stop carrying
    that Delivery Note (delivery_note_id) and its value, so the driver app
    shows and returns against what was actually loaded. A plan with no
    orders can't make a manifest (use Reconcile Dispatch first).
    """
    from nexus_supply_chain.driver_api import build_stop_fields
    from crystal_custom.crystal_customizations import dispatch_engine as engine

    if not frappe.has_permission("Crystal Truck Plan", "read", source_name):
        frappe.throw("You don't have permission to use this Truck Plan.", frappe.PermissionError)

    existing_manifest = frappe.db.get_value(
        "Vehicle Delivery Manifest",
        {"truck_plan": source_name, "docstatus": ["<", 2]},
        "name",
    )
    if existing_manifest:
        return {
            "status": "exists",
            "manifest_id": existing_manifest,
            "message": "A Delivery Manifest already exists for this Truck Plan.",
        }

    source = frappe.get_doc("Crystal Truck Plan", source_name)
    if source.docstatus != 1:
        frappe.throw("Submit the Truck Plan before creating its Delivery Manifest.")
    if not [r for r in source.orders if r.sales_order]:
        frappe.throw(
            _("This Truck Plan has no orders. Use Nexus Actions → Reconcile Dispatch to load its Delivery Notes and route first."),
            title=_("No Orders on the Plan"),
        )

    target = frappe.new_doc("Vehicle Delivery Manifest")
    target.truck_plan = source.name
    target.trip_status = "Manifested"

    vehicle = _match_vehicle(source.get("truck_number"))
    if vehicle and frappe.db.get_value("Vehicle In Transit", vehicle, "current_status") not in ("Idle", "Loading", None, ""):
        vehicle = None  # busy on another trip: leave it for the dispatcher to choose
    if vehicle:
        target.vehicle = vehicle
        target.driver = frappe.db.get_value("Vehicle In Transit", vehicle, "current_driver")

    target.profit_loss = source.narrowed_gross_profit
    target.gross_margin = source.narrowed_gross_margin_percentage
    target.approximate_total_distance_km = source.approximate_total_distance_km
    target.approximate_fuel_consumption_ltrs = source.approximate_fuel_consumption_ltrs
    target.approximate_fuel_cost = source.approximate_fuel_cost
    target.actual_fuel_fuelled = source.actual_fuel_fuelled
    target.profitability_status = source.profitability_status
    target.route_geojson = source.route_geojson

    missing_pins = []
    for order_row in source.orders:
        if not order_row.sales_order:
            continue
        if order_row.get("delivery_note"):
            stop = engine.stop_fields(order_row)
        else:
            stop = build_stop_fields(order_row.sales_order)
            if not stop:
                continue
            if order_row.get("customer_name"):
                stop["customer"] = order_row.customer_name
            stop["weight_kg"] = order_row.total_net_weight
            stop["delivery_status"] = "Pending"
        if not stop.get("combined_coordinates"):
            missing_pins.append(stop.get("customer") or order_row.sales_order)
        target.append("stops", stop)

    target.insert(ignore_permissions=True)

    message = "Vehicle Delivery Manifest drafted successfully."
    if not vehicle:
        message += " Select the vehicle before submitting (no free vehicle matched the truck number)."
    if missing_pins:
        message += f" {len(missing_pins)} stop(s) have no customer location yet."

    return {
        "status": "success",
        "manifest_id": target.name,
        "message": message,
        "vehicle_matched": bool(vehicle),
        "stops_without_location": missing_pins,
    }


# ============================================================================
# RECONCILE DISPATCH (Batch 12)
#
# The fallback for a plan that was saved without its orders or route (e.g.
# submitted by hand, or a Dispatch that failed half-way), and the way to add
# or remove drops on a plan that was already dispatched. It runs the SAME
# engine as the Truck Assignment Dispatch button: Delivery Notes -> rows,
# route (Google or Hosted), distance, GeoJSON, fuel, margin, Sales Order
# flags and the manifest (including a trip already on the road).
#
#   get_reconcile_candidates   dialog step 1: find DNs (date + vehicle), plus
#                              the DNs of the plan's own orders
#   get_delivery_note_for_reconcile   add one DN by hand
#   preview_reconcile          dialog step 2: the full result, nothing saved
#   reconcile_dispatch         apply (one transaction, locked)
# ============================================================================
RECONCILE_LOCK_TTL = 180


def _engine():
    from crystal_custom.crystal_customizations import dispatch_engine

    return dispatch_engine


def _require_reconcile_permission(plan_name):
    if not frappe.has_permission("Crystal Truck Plan", "submit", plan_name):
        frappe.throw(_("Only users who can submit Crystal Truck Plans can reconcile a dispatch."), frappe.PermissionError)


def _load_plan(plan_name):
    if not plan_name or not frappe.db.exists("Crystal Truck Plan", plan_name):
        frappe.throw(_("Truck Plan {0} was not found.").format(plan_name))
    plan = frappe.get_doc("Crystal Truck Plan", plan_name)
    if plan.docstatus == 2:
        frappe.throw(_("This Truck Plan is cancelled. Amend it first."), title=_("Cancelled Plan"))
    return plan


def _locked_stops(plan_name):
    """DNs / Sales Orders whose manifest stop is already confirmed (can't be removed)."""
    engine = _engine()
    m = engine.manifest_for_plan(plan_name)
    if not m or m.docstatus != 1:
        return {"delivery_notes": [], "sales_orders": [], "manifest": m}
    dns, sos = [], []
    for s in engine._stops(m.name):
        if (s.delivery_status or "Pending") == "Pending":
            continue
        if s.get("delivery_note_id"):
            dns.append(s.delivery_note_id)
        elif s.sales_order:
            sos.append(s.sales_order)
    return {"delivery_notes": dns, "sales_orders": sos, "manifest": m}


@frappe.whitelist()
def get_reconcile_candidates(plan_name, from_date=None, to_date=None, vehicle_no=None):
    engine = _engine()
    _require_reconcile_permission(plan_name)
    plan = _load_plan(plan_name)

    current = engine.plan_delivery_notes(plan)
    legacy = [r for r in plan.orders if not r.get("delivery_note") and r.sales_order]
    resolved, missing, by_so = engine.resolve_delivery_notes([r.sales_order for r in legacy], plan.name)

    found = []
    if vehicle_no and from_date and to_date:
        if getdate(from_date) > getdate(to_date):
            frappe.throw(_("From Date must be on or before To Date."))
        found = engine.find_delivery_notes(from_date, to_date, vehicle_no)

    names = engine._unique(current + resolved + found)
    summaries = engine.delivery_note_summaries(names, plan.name)
    sources = {}
    for n in found:
        sources[n] = _("Vehicle & date")
    for n in resolved:
        sources[n] = _("Plan's Sales Order")
    for n in current:
        sources[n] = _("On this plan")

    locked = _locked_stops(plan.name)
    m = locked["manifest"]
    rows = []
    for n, s in summaries.items():
        row = engine.public_summary(s)
        row["source"] = sources.get(n, "")
        row["locked"] = n in locked["delivery_notes"]
        row["selected"] = (not s["problems"]) or row["locked"]
        rows.append(row)

    missing_by_so = {m_["sales_order"]: m_["reason"] for m_ in missing}
    legacy_rows = [{
        "sales_order": r.sales_order,
        "customer_name": r.customer_name or "",
        "delivery_notes": by_so.get(r.sales_order, []),
        "reason": missing_by_so.get(r.sales_order, ""),
        "locked": r.sales_order in locked["sales_orders"],
    } for r in legacy]

    return {
        "plan": {"name": plan.name, "docstatus": plan.docstatus, "truck_number": plan.truck_number,
                 "plan_date": str(plan.plan_date) if plan.plan_date else None,
                 "capacity_kg": plan.capacity_kg, "order_count": len(plan.orders)},
        "delivery_notes": rows,
        "legacy_orders": legacy_rows,
        "manifest": ({"name": m.name, "docstatus": m.docstatus, "trip_status": m.trip_status} if m else None),
        "routing": engine.routing_options(0),
    }


@frappe.whitelist()
def get_delivery_note_for_reconcile(plan_name, delivery_note):
    engine = _engine()
    _require_reconcile_permission(plan_name)
    s = engine.delivery_note_summaries([delivery_note], plan_name).get(delivery_note)
    row = engine.public_summary(s)
    row["source"] = _("Added by hand")
    row["locked"] = False
    row["selected"] = not s["problems"]
    return row


def _plan_reconcile(plan, delivery_notes, removed_orders=None, route_provider=None):
    """Everything reconcile would do, computed WITHOUT writing anything."""
    engine = _engine()
    dns = engine.parse_list(delivery_notes)
    removed = set(engine.parse_list(removed_orders))
    summaries = engine.delivery_note_summaries(dns, plan.name)

    problems = [{"delivery_note": n, "problems": s["problems"]} for n, s in summaries.items() if s["problems"]]
    selected_sos = engine._unique([so for s in summaries.values() for so in s["sales_orders"]])
    legacy = [r for r in plan.orders if not r.get("delivery_note") and r.sales_order]
    uncovered = [r.sales_order for r in legacy if r.sales_order not in selected_sos and r.sales_order not in removed]
    uncovered_details = engine.missing_details(uncovered)
    for d in uncovered_details:
        d["reason"] = _("{0} — add its Delivery Note or tick “Remove from plan”.").format(d["reason"])

    current = engine.plan_delivery_notes(plan)
    rows_view = [frappe._dict(delivery_note=n, sales_orders=s["sales_orders"]) for n, s in summaries.items()]
    impact = engine.manifest_impact(plan.name, rows_view)

    located = sum(1 for s in summaries.values() if s["has_location"])
    routing = engine.routing_options(located)
    provider = route_provider if route_provider in engine.PROVIDERS else routing["default"]
    provider_note = ""
    if provider == engine.PROVIDER_GOOGLE and not routing["google_available"]:
        provider_note = routing["reason"]
        provider = engine.PROVIDER_HOSTED

    previous_sos = engine.plan_sales_orders(plan)
    released = [so for so in previous_sos if so not in set(selected_sos)]
    other_trucks = sorted({t for s in summaries.values() for t in s.get("other_trucks") or []
                           if t and t != plan.truck_number})

    blocked = bool(problems or uncovered_details or impact.get("blocked") or not summaries)
    return {
        "status": "blocked" if blocked else "ok",
        "blocked": {"problems": problems, "uncovered": uncovered_details,
                    "confirmed": impact.get("blocked") or [], "empty": not summaries},
        "delivery_notes": list(summaries.keys()),
        "stops": [{
            "delivery_note": n, "customer_name": s.get("customer_name"), "sales_orders": s["sales_orders"],
            "posting_date": s.get("posting_date"), "grand_total": s.get("grand_total", 0),
            "total_net_weight": s.get("total_net_weight", 0), "has_location": s["has_location"],
            "item_count": s.get("item_count", 0), "change": "kept" if n in current else "added",
        } for n, s in summaries.items()],
        "removed_delivery_notes": [n for n in current if n not in summaries],
        "removed_orders": sorted(removed),
        "released_sales_orders": released,
        "other_trucks": other_trucks,
        "totals": {"value": sum(flt(s.get("grand_total")) for s in summaries.values()),
                   "weight": sum(flt(s.get("total_net_weight")) for s in summaries.values()),
                   "located": located, "unlocated": len(summaries) - located},
        "routing": routing,
        "route_provider": provider,
        "provider_note": provider_note,
        "manifest": impact,
        "previous_sales_orders": previous_sos,
        "plan_docstatus": plan.docstatus,
    }


def _raise_if_blocked(p):
    engine = _engine()
    if p["status"] == "ok":
        return
    b = p["blocked"]
    if b["uncovered"]:
        frappe.throw(engine.missing_dn_message(b["uncovered"]), title=_("Delivery Note Missing"))
    if b["problems"]:
        rows = "".join(f"<li><b>{engine._esc(x['delivery_note'])}</b>: {engine._esc(', '.join(x['problems']))}</li>" for x in b["problems"])
        frappe.throw(_("These Delivery Notes can't be used:") + f"<ul>{rows}</ul>", title=_("Delivery Notes Can't Be Used"))
    if b["confirmed"]:
        rows = "".join(f"<li>{engine._esc(x['label'])} ({engine._esc(x['status'])})</li>" for x in b["confirmed"])
        frappe.throw(_("These stops are already confirmed on the manifest and can't be removed:") + f"<ul>{rows}</ul>",
                     title=_("Stop Already Delivered"))
    frappe.throw(_("Select at least one Delivery Note."), title=_("Nothing to Dispatch"))


@frappe.whitelist()
def preview_reconcile(plan_name, delivery_notes, removed_orders=None, route_provider=None):
    _require_reconcile_permission(plan_name)
    plan = _load_plan(plan_name)
    p = _plan_reconcile(plan, delivery_notes, removed_orders, route_provider)
    m = p["manifest"]
    if m.get("action") in ("live", "rebuild") and not frappe.has_permission("Vehicle Delivery Manifest", "submit"):
        p["status"] = "blocked"
        p["blocked"]["permission"] = _("This plan's manifest {0} would change, and you can't submit Delivery Manifests.").format(m.get("manifest"))
    p.pop("previous_sales_orders", None)
    return p


@frappe.whitelist(methods=["POST"])
def reconcile_dispatch(plan_name, delivery_notes, removed_orders=None, route_provider=None):
    """
    Applies a reconciliation in ONE transaction: plan rows from the Delivery
    Notes, route (Google/Hosted), distance, GeoJSON, fuel, margin, submit (if
    draft), Sales Order truck flags, manifest stops, timeline. Anything that
    fails rolls everything back.
    """
    engine = _engine()
    _require_reconcile_permission(plan_name)

    cache = frappe.cache()
    lock_key = f"nexus:ctp_reconcile:{plan_name}"
    if not cache.set(cache.make_key(lock_key), frappe.session.user, ex=RECONCILE_LOCK_TTL, nx=True):
        frappe.throw(_("This plan is being reconciled by someone else right now. Try again in a minute."),
                     title=_("Reconcile in Progress"))
    try:
        frappe.db.sql("SELECT name FROM `tabCrystal Truck Plan` WHERE name = %s FOR UPDATE", plan_name)
        plan = _load_plan(plan_name)
        p = _plan_reconcile(plan, delivery_notes, removed_orders, route_provider)
        _raise_if_blocked(p)
        if p["manifest"].get("action") in ("live", "rebuild") and not frappe.has_permission("Vehicle Delivery Manifest", "submit"):
            frappe.throw(_("This plan's manifest would change, and you can't submit Delivery Manifests."), frappe.PermissionError)

        was_draft = plan.docstatus == 0
        result = engine.build_dispatch(plan, p["delivery_notes"], p["route_provider"], engine.SOURCE_RECONCILE)
        if was_draft:
            plan.save(ignore_permissions=True)
            plan.submit()
        else:
            plan.flags.ignore_validate_update_after_submit = True
            plan.save(ignore_permissions=True)

        so_sync = engine.sync_sales_orders(plan, p["previous_sales_orders"])
        manifest = engine.sync_manifest(plan, result)

        lines = [
            f"🔁 <b>Reconcile Dispatch</b> by <b>{engine._esc(frappe.session.user)}</b>",
            f"Stops: {len(plan.orders)} Delivery Note(s) · route {engine._esc(result['route_provider'] or 'none')}"
            f" · {flt(result['distance_km']):,.1f} km · fuel {flt(result['fuel_cost']):,.2f}"
            f" · narrowed margin {flt(plan.narrowed_gross_margin_percentage):.2f}%",
        ]
        added = [s["delivery_note"] for s in p["stops"] if s["change"] == "added"]
        if added:
            lines.append("Added: " + engine._esc(", ".join(added)))
        if p["removed_delivery_notes"]:
            lines.append("Removed: " + engine._esc(", ".join(p["removed_delivery_notes"])))
        if so_sync["released"]:
            lines.append("Sales Orders released back to Truck Assignment: " + engine._esc(", ".join(so_sync["released"])))
        if manifest.get("manifest"):
            lines.append(f"Manifest {engine._esc(manifest['manifest'])}: {engine._esc(manifest.get('action'))}"
                         + (f" ({manifest.get('added', 0)} added, {manifest.get('removed', 0)} removed)" if manifest.get("action") == "updated" else ""))
        for w in result["warnings"]:
            lines.append("⚠️ " + engine._esc(w))
        plan.add_comment("Info", "<br>".join(lines))

        frappe.db.commit()
    finally:
        cache.delete_value(lock_key)

    return {
        "status": "success",
        "plan": plan.name,
        "submitted": was_draft,
        "route_provider": result["route_provider"],
        "distance_km": result["distance_km"],
        "stop_count": result["stop_count"],
        "warnings": result["warnings"],
        "released_sales_orders": so_sync["released"],
        "manifest": manifest,
    }

