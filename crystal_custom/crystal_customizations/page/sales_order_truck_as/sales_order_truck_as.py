import frappe
import json
import os
import requests
from frappe.utils import flt
from frappe import _


# ---------------------------------------------------------------------------
# Private-file helpers for truck metadata
# tabDefaultValue.defvalue is TEXT (~64 KB) and overflows when many trucks
# accumulate across sessions. A private file has no practical size limit.
# ---------------------------------------------------------------------------

def _truck_meta_path():
    return frappe.get_site_path('private', 'files', 'crystal_truck_meta.json')


def _read_truck_meta():
    path = _truck_meta_path()
    if os.path.exists(path):
        with open(path) as f:
            return f.read()
    # One-time migration from the old frappe.defaults key
    legacy = frappe.db.get_default('crystal_truck_meta')
    if legacy:
        _write_truck_meta(legacy)
        return legacy
    return '[]'


def _write_truck_meta(data_json):
    path = _truck_meta_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        f.write(data_json)

CRYSTAL_API_BASE_URL = "https://crystal-api.crystalapps.dev"
CRYSTAL_API_INTERNAL_SECRET = frappe.conf.get("crystal_api_internal_secret")

@frappe.whitelist()
def get_truck_assignment_orders(from_date=None, to_date=None, sales_persons_json=None, regions_json=None):
    """
    Return truck-assigned and unassigned orders for the Truck Assignment page.
    SP filtering is done via SQL JOIN so it always works correctly.
    Returns sales_persons per order so the search box can filter by SP name.
    """
    import json 
    sps     = json.loads(sales_persons_json) if sales_persons_json else []
    regions = json.loads(regions_json)        if regions_json        else []

    has_pf = frappe.db.has_column('Sales Order', 'custom_is_pre_fulfillment')
    pf_expr = (
        'IFNULL(so.custom_is_pre_fulfillment, 0) AS custom_is_pre_fulfillment'
        if has_pf else '0 AS custom_is_pre_fulfillment'
    )

    # Build optional SP join / where clause
    sp_join  = ''
    sp_where = ''
    params   = {}
    if sps:
        sp_join  = 'INNER JOIN `tabSales Team` st ON st.parent = so.name AND st.parenttype = "Sales Order"'
        sp_ph    = ', '.join([f'%(sp{i})s' for i in range(len(sps))])
        sp_where = f'AND st.sales_person IN ({sp_ph})'
        for i, sp in enumerate(sps):
            params[f'sp{i}'] = sp

    select_cols = f"""
    so.name, so.customer, so.customer_name, so.transaction_date,
    so.delivery_date,
    IFNULL(so.per_delivered, 0) AS per_delivered,
    IFNULL(so.per_billed,    0) AS per_billed,
    so.grand_total, so.custom_delivery_region, so.owner,
    so.custom_truck_number, so.total_net_weight,
    IFNULL(so.custom_call_not_picked, 0) AS custom_call_not_picked,
    so.custom_call_notes,
    so.workflow_state, so.docstatus,
    {pf_expr},
    IFNULL(c.custom_latitude, 0.0)  AS custom_latitude,
    IFNULL(c.custom_longitude, 0.0) AS custom_longitude,
    (SELECT GROUP_CONCAT(DISTINCT st2.sales_person
                         ORDER BY st2.sales_person SEPARATOR ', ')
     FROM `tabSales Team` st2
     WHERE st2.parent = so.name) AS sales_persons
"""

    region_where = ''
    if regions:
        rph = ', '.join([f'%(rgn{i})s' for i in range(len(regions))])
        region_where = f' AND so.custom_delivery_region IN ({rph})'
        for i, r in enumerate(regions):
            params[f'rgn{i}'] = r

    date_where = ''
    if from_date:
        params['from_date'] = from_date
        date_where += ' AND DATE(so.transaction_date) >= %(from_date)s'
    if to_date:
        params['to_date'] = to_date
        date_where += ' AND DATE(so.transaction_date) <= %(to_date)s'

    sp_region = f"{sp_where} {region_where}"

    # Truck-assigned: no date filter, no status filter — custom_truck_closed=1 is the sole signal
    # a trip is over. Completed/Closed orders stay visible on their truck (for value/weight review)
    # but the frontend badges them as "Invoiced" and prevents reassignment.
    assigned = frappe.db.sql(f"""
        SELECT DISTINCT {select_cols},
            so.status AS so_status
        FROM `tabSales Order` so {sp_join}
        LEFT JOIN `tabCustomer` c ON so.customer = c.name
        WHERE so.docstatus IN (0, 1)
          AND (so.docstatus = 1 OR IFNULL(so.workflow_state, '') != 'Cancelled')
          {sp_region}
          AND so.custom_truck_number IS NOT NULL
          AND so.custom_truck_number != ''
          AND IFNULL(so.custom_truck_closed, 0) != 1
          AND IFNULL(so.custom_truck_dispatched, 0) != 1
        ORDER BY so.transaction_date DESC
        LIMIT 500
    """, params, as_dict=1)

    # Unassigned orders: orders with no truck, including those unassigned from a truck.
    # Dispatched orders do not come back here.
    # Date filter only applies to draft orders so old confirmed orders are never hidden.
    unassigned = frappe.db.sql(f"""
        SELECT DISTINCT
            {select_cols},
            so.status AS so_status
        FROM `tabSales Order` so {sp_join}
        LEFT JOIN `tabCustomer` c ON so.customer = c.name
        WHERE so.docstatus IN (0, 1)
          AND (so.docstatus = 1 OR IFNULL(so.workflow_state, '') != 'Cancelled')
          AND so.status NOT IN ('Completed', 'Closed')
          AND IFNULL(so.per_delivered, 0) = 0
          AND IFNULL(so.per_billed, 0) = 0
          {sp_region}
          AND (1=1 {date_where})
          AND (
              (so.custom_truck_number IS NULL OR so.custom_truck_number = '')
          )
        ORDER BY so.docstatus DESC, so.transaction_date DESC
        LIMIT 1000
    """, params, as_dict=1)

    return {'assigned': [dict(r) for r in assigned], 'unassigned': [dict(r) for r in unassigned]}

@frappe.whitelist()
def debug_order_visibility(order_name):
    """Temporary debug: return raw field values + which query conditions fail for an order."""
    row = frappe.db.sql("""
        SELECT name, docstatus, status, workflow_state,
               custom_truck_number, custom_truck_closed, custom_truck_dispatched,
               IFNULL(per_delivered, 0) AS per_delivered,
               IFNULL(per_billed, 0)    AS per_billed,
               transaction_date, delivery_date,
               custom_delivery_region
        FROM `tabSales Order`
        WHERE name = %(name)s
    """, {'name': order_name}, as_dict=1)
    if not row:
        return {'error': 'order not found'}
    o = row[0]
    tn = (o.custom_truck_number or '').strip()
    tc = int(o.custom_truck_closed or 0)
    dp = int(o.custom_truck_dispatched or 0)
    return {
        'raw': dict(o),
        'in_assigned_candidate': bool(tn and tc != 1 and dp != 1),
        'in_unassigned_candidate': not tn,
        'status_excluded': o.status in ('Completed', 'Closed'),
        'docstatus_excluded': o.docstatus not in (0, 1),
        'wf_excluded': (o.docstatus == 0 and (o.workflow_state or '') == 'Cancelled'),
    }

@frappe.whitelist()
def calculate_route_proxy(coordinates_json):
    coordinates = frappe.parse_json(coordinates_json) if isinstance(coordinates_json, str) else coordinates_json
    try:
        resp = requests.post(
            f"{CRYSTAL_API_BASE_URL}/calculate-route",
            json={"coordinates": coordinates},
            headers={"x-internal-secret": CRYSTAL_API_INTERNAL_SECRET or ""},
            timeout=20
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        frappe.log_error(f"calculate_route_proxy failed: {e}", "Truck Assignment Route Proxy")
        return {"error": str(e)}



# ============================================================================
# Nexus Batch 12: route engine choice for "Optimize Route" / "Analyse Margins"
# (Google Routes API or the Hosted engine). Read-only previews: nothing is
# saved on any document. The Google key is read on the server only and is
# never returned to the browser.
# ============================================================================
@frappe.whitelist()
def get_routing_status():
    """
    What the page's route-engine dialog may offer. Returns only booleans and
    limits, NEVER the key. Hosted is the default; Google is offered (not
    greyed out) only when its server key is configured.
    """
    from crystal_custom.crystal_customizations import dispatch_engine as engine

    configured = bool(engine.google_server_key())
    return {
        'google_configured': configured,
        'google_max_stops': engine.GOOGLE_MAX_STOPS,
        'default': engine.PROVIDER_HOSTED,
        'providers': list(engine.PROVIDERS),
        'reason': '' if configured else _(
            "Google routing isn't set up (Nexus App Settings → Google Maps Server API Key)."),
    }


@frappe.whitelist()
def get_route_preview(coordinates_json, route_provider=None):
    """
    Route preview for the Truck Assignment map and margin analysis.

    coordinates_json: [[lng, lat] yard, [lng, lat] stop 1, ..., [lng, lat] yard]
        (the same payload the page already builds for calculate_route_proxy;
        a {"coordinates": [...]} object is accepted too).
    route_provider: 'Hosted' (default) or 'Google'.

    Returns the same GeoJSON FeatureCollection shape the page already draws
    (features[0].properties.summary.distance / duration, features[0].geometry)
    plus:
        waypoint_order: visiting order as indices into the stops that were sent
                        (yard excluded), one index per stop sent;
        provider:       the engine that actually ran ('Google' or 'Hosted');
        warnings:       list of human-readable notes (fallbacks, skipped stops).
    On failure returns {'error': '...'} (same convention as calculate_route_proxy).

    Same stop coordinates are routed once (several orders for one customer)
    and expanded back. Identical requests within 10 minutes are served from
    cache, so pressing the button again doesn't cost another Google request.
    """
    import hashlib
    import json
    from crystal_custom.crystal_customizations import dispatch_engine as engine

    if not frappe.has_permission('Crystal Truck Plan', 'read'):
        return {'error': _('You are not permitted to plan truck routes.')}

    try:
        payload = json.loads(coordinates_json) if isinstance(coordinates_json, str) else coordinates_json
    except ValueError:
        return {'error': _('Invalid route coordinates.')}
    if isinstance(payload, dict):
        payload = payload.get('coordinates')
    if not isinstance(payload, (list, tuple)) or len(payload) < 3:
        return {'error': _('A route needs the yard and at least one stop.')}

    def to_point(pair):
        # [lng, lat] (GeoJSON order) -> (lat, lng) or None
        if not isinstance(pair, (list, tuple)) or len(pair) < 2:
            return None
        return engine._point(pair[1], pair[0])

    factory = to_point(payload[0]) or engine._factory()
    if not factory:
        return {'error': _('The company has no GPS coordinates (Company → custom_latitude / custom_longitude).')}

    stops = list(payload[1:-1])
    max_stops = 200
    if len(stops) > max_stops:
        return {'error': _('Too many stops for one route ({0}); the limit is {1}.').format(len(stops), max_stops)}

    warnings = []
    unique_points, members, skipped = [], [], []
    seen = {}
    for i, pair in enumerate(stops):
        pt = to_point(pair)
        if not pt:
            skipped.append(i)
            continue
        spot = (round(pt[0], 6), round(pt[1], 6))
        if spot not in seen:
            seen[spot] = len(unique_points)
            unique_points.append(pt)
            members.append([])
        members[seen[spot]].append(i)
    if skipped:
        warnings.append(_('{0} stop(s) have no valid location and are left out of the route.').format(len(skipped)))
    if not unique_points:
        return {'error': _('No stop has a valid location, so no route can be drawn.')}

    provider = route_provider if route_provider in engine.PROVIDERS else engine.PROVIDER_HOSTED
    key = ''
    if provider == engine.PROVIDER_GOOGLE:
        key = engine.google_server_key()
        if not key:
            warnings.append(_("Google routing isn't set up, so the hosted engine was used."))
            provider = engine.PROVIDER_HOSTED
        elif len(unique_points) > engine.GOOGLE_MAX_STOPS:
            warnings.append(_('{0} stops: Google optimises at most {1} stops in one request, so the hosted engine was used.').format(
                len(unique_points), engine.GOOGLE_MAX_STOPS))
            provider = engine.PROVIDER_HOSTED

    def cache_key(engine_name):
        raw = json.dumps([engine_name, factory, unique_points], separators=(',', ':'))
        return 'nexus_route_preview:' + hashlib.sha256(raw.encode()).hexdigest()

    def from_cache(engine_name):
        try:
            hit = frappe.cache().get_value(cache_key(engine_name))
            return json.loads(hit) if hit else None
        except Exception:
            return None

    data = None
    if provider == engine.PROVIDER_GOOGLE:
        data = from_cache(provider)
        if data is None:
            try:
                data = engine._route_google(factory, unique_points, key)
            except Exception as e:
                frappe.log_error(title='Nexus Route Preview: Google route failed',
                                 message=f'{e}\n{frappe.get_traceback()}')
                warnings.append(_('Google routing failed ({0}); the hosted engine was used.').format(str(e)[:160]))
                provider = engine.PROVIDER_HOSTED
    if data is None:
        data = from_cache(provider)
    if data is None:
        try:
            data = engine._route_hosted(factory, unique_points)
        except Exception as e:
            frappe.log_error(title='Nexus Route Preview: hosted route failed',
                             message=f'{e}\n{frappe.get_traceback()}')
            return {'error': _('The hosted routing engine failed: {0}').format(str(e)[:200])}

    if not isinstance(data, dict) or not data.get('features'):
        return {'error': _('The routing engine returned no route.')}
    try:
        frappe.cache().set_value(cache_key(provider), json.dumps(data, separators=(',', ':')), expires_in_sec=600)
    except Exception:
        pass

    order = data.get('waypoint_order')
    if not isinstance(order, list) or sorted(order) != list(range(len(unique_points))):
        order = list(range(len(unique_points)))
    expanded = [stop_index for u in order for stop_index in members[u]] + skipped

    result = dict(data)
    result['waypoint_order'] = expanded
    result['provider'] = provider
    result['warnings'] = warnings
    return result


@frappe.whitelist()
def get_company_coordinates(company=None):
    if not company:
        company = frappe.defaults.get_user_default("Company")
    if not company:
        frappe.throw(_("No default Company found. Please set a Company in Global Defaults."))
    lat = frappe.db.get_value("Company", company, "custom_latitude")
    lng = frappe.db.get_value("Company", company, "custom_longitude")
    if not lat or not lng:
        return {"status": "error", "message": f"GPS coordinates missing for Company '{company}'."}
    return {"status": "success", "lat": flt(lat), "lng": flt(lng)}


@frappe.whitelist()
def get_vehicle_routing_economics(distance_km, vehicle_type=None, truck_number=None):
    try:
        distance_km = flt(distance_km)
    except (ValueError, TypeError):
        return {"status": "error", "message": "Distance must be a valid numerical value."}

    # Resolve vehicle_type from the truck's active Draft Crystal Truck Plan if not
    # passed explicitly — mirrors the original resolution chain so the truck-card
    # "Margins"/"Route" buttons keep working even when vehicle_type isn't in payload.
    if not vehicle_type and truck_number:
        vehicle_type = frappe.db.get_value(
            'Crystal Truck Plan', {'truck_number': truck_number, 'docstatus': 0}, 'capacity_kg'
        )

    if not vehicle_type:
        return {"status": "error", "message": f"Could not determine Vehicle Type for Route/Truck: {truck_number or 'Unknown'}"}

    vt_data = frappe.db.get_value('Vehicle Type', vehicle_type,
        ["name", "max_tonnage", "fuel_type", "litre_cost", "consumption_km_per_ltr"], as_dict=True)
    if not vt_data:
        return {"status": "error", "message": f"Vehicle Type '{vehicle_type}' not found in the system."}

    consumption = flt(vt_data.get("consumption_km_per_ltr"))
    litre_cost = flt(vt_data.get("litre_cost"))
    if consumption <= 0:
        return {"status": "error", "message": f"Fuel consumption (Km/L) not configured for '{vehicle_type}'."}
    if litre_cost <= 0:
        return {"status": "error", "message": f"Litre Cost for '{vehicle_type}' is zero or not set."}

    total_litres = distance_km / consumption
    total_cost = total_litres * litre_cost
    currency = frappe.defaults.get_global_default("default_currency") or "KES"

    return {
        "status": "success",
        "estimated_fuel_cost": round(total_cost, 2),
        "total_litres_required": round(total_litres, 2),
        "distance_km": distance_km,
        "currency": currency,
        "economics_used": vt_data
    }


@frappe.whitelist()
def get_fleet_settings():
    threshold = frappe.db.get_single_value("Crystal Fleet Settings", "narrowed_margin_profitability_threshold")
    return {"narrowed_margin_profitability_threshold": flt(threshold) if threshold is not None else 33.0}


def _apply_order_sequence_to_plan(plan, sequence):
    order_position = {so_name: pos for pos, so_name in enumerate(sequence)}
    fallback_base = len(sequence)
    def sort_key(row):
        return order_position.get(row.sales_order, fallback_base + (row.idx or 0))
    plan.orders.sort(key=sort_key)


@frappe.whitelist()
def reorder_truck_plan_orders(truck_number, sales_order_sequence_json):
    sequence = frappe.parse_json(sales_order_sequence_json) if isinstance(sales_order_sequence_json, str) else sales_order_sequence_json
    if not sequence:
        return {"status": "skipped", "message": "No sequence provided."}
    plan_name = frappe.db.get_value('Crystal Truck Plan', {'truck_number': truck_number, 'docstatus': 0}, 'name')
    if not plan_name:
        return {"status": "skipped", "message": f"No active draft plan for truck {truck_number}."}
    plan = frappe.get_doc('Crystal Truck Plan', plan_name)
    _apply_order_sequence_to_plan(plan, sequence)
    plan.save(ignore_permissions=True)
    frappe.db.commit()
    return {"status": "success", "updated": len(plan.orders)}

@frappe.whitelist()
def set_truck_number(order_name, truck_number):
    frappe.db.set_value('Sales Order', order_name, {
        'custom_truck_number': truck_number or '',
        'custom_truck_closed': 0,
        'custom_truck_dispatched': 0,
    })
    return True

@frappe.whitelist()
def set_pre_fulfillment(order_name, value=1):
    frappe.db.set_value('Sales Order', order_name, 'custom_is_pre_fulfillment', int(value))
    return True

def _get_valid_route_coordinates(plan):
    company_coords = get_company_coordinates()
    if company_coords.get("status") != "success":
        return None, 0, len(plan.orders), []

    factory_lat = flt(company_coords["lat"])
    factory_lng = flt(company_coords["lng"])
    total_order_count = len(plan.orders)
    valid_order_count = 0
    coordinates = [[factory_lng, factory_lat]]
    so_names = []

    for row in plan.orders:
        so_customer = frappe.db.get_value("Sales Order", row.sales_order, "customer")
        if not so_customer:
            continue
        cust_lat = flt(frappe.db.get_value("Customer", so_customer, "custom_latitude"))
        cust_lng = flt(frappe.db.get_value("Customer", so_customer, "custom_longitude"))
        if not cust_lat or not cust_lng:
            continue
        coordinates.append([cust_lng, cust_lat])
        so_names.append(row.sales_order)
        valid_order_count += 1

    if valid_order_count == 0:
        return None, 0, total_order_count, []
    coordinates.append([factory_lng, factory_lat])
    return coordinates, valid_order_count, total_order_count, so_names


def _compute_route_and_margin_for_dispatch(plan):
    distance_km = None
    duration_seconds = None
    route_geojson_str = None

    try:
        coordinates, valid_count, total_count, so_names = _get_valid_route_coordinates(plan)
        if coordinates:
            resp = requests.post(
                f"{CRYSTAL_API_BASE_URL}/calculate-route",
                json={"coordinates": coordinates},
                headers={"x-internal-secret": CRYSTAL_API_INTERNAL_SECRET or ""},
                timeout=20
            )
            resp.raise_for_status()
            data = resp.json()
            if "features" in data:
                route_geojson_str = json.dumps(data)
                summary = data["features"][0]["properties"].get("summary", {})
                distance_km = flt(summary.get("distance", 0)) / 1000.0
                duration_seconds = int(flt(summary.get("duration", 0)))
                waypoint_order = data.get("waypoint_order")
                if waypoint_order and so_names:
                    sequence = [so_names[i] for i in waypoint_order if i < len(so_names)]
                    _apply_order_sequence_to_plan(plan, sequence)
    except Exception as e:
        frappe.log_error(f"Dispatch route computation failed for {plan.name}: {e}", "Truck Plan Dispatch — Routing")

    fuel_litres = fuel_cost = None
    if distance_km is not None and plan.capacity_kg:
        try:
            fuel_result = get_vehicle_routing_economics(distance_km=distance_km, vehicle_type=plan.capacity_kg)
            if fuel_result.get("status") == "success":
                fuel_litres = fuel_result.get("total_litres_required")
                fuel_cost = fuel_result.get("estimated_fuel_cost")
        except Exception as e:
            frappe.log_error(f"Dispatch fuel computation failed for {plan.name}: {e}", "Truck Plan Dispatch — Fuel")

    margin_result = None
    try:
        from nexus_supply_chain.routing.margin_analysis import get_margin_analysis
        sales_order_names = [row.sales_order for row in plan.orders if row.sales_order]
        margin_result = get_margin_analysis(
            sales_orders=sales_order_names, distance_km=distance_km, vehicle_type=plan.capacity_kg
        )
    except Exception as e:
        frappe.log_error(f"Dispatch margin computation failed for {plan.name}: {e}", "Truck Plan Dispatch — Margin")

    return {
        "distance_km": distance_km, "duration_seconds": duration_seconds,
        "route_geojson": route_geojson_str, "fuel_litres": fuel_litres,
        "fuel_cost": fuel_cost, "margin": margin_result
    }

@frappe.whitelist()
def set_truck_closed(order_name, value=1):
    values = {'custom_truck_closed': int(value)}
    if not int(value):
        # Reopening a trip puts its orders back on the Truck Assignment page.
        values['custom_truck_dispatched'] = 0
    frappe.db.set_value('Sales Order', order_name, values)
    return True

@frappe.whitelist()
def mark_orders_dispatched(order_names_json):
    """Take dispatched orders off the Truck Assignment page only. This does not set
    custom_truck_closed, because other pages use that flag to hide orders."""
    import json
    names = json.loads(order_names_json) if isinstance(order_names_json, str) else order_names_json
    if not names:
        return True
    ph = ', '.join(['%s'] * len(names))
    frappe.db.sql(
        f"UPDATE `tabSales Order` SET custom_truck_dispatched = 1 WHERE name IN ({ph})",
        names
    )
    frappe.db.commit()
    return True

@frappe.whitelist()
def close_truck_orders(order_names_json):
    """Batch-set custom_truck_closed=1 for all orders in a single DB call."""
    import json
    names = json.loads(order_names_json) if isinstance(order_names_json, str) else order_names_json
    if not names:
        return True
    ph = ', '.join(['%s'] * len(names))
    frappe.db.sql(
        f"UPDATE `tabSales Order` SET custom_truck_closed = 1 WHERE name IN ({ph})",
        names
    )
    frappe.db.commit()
    return True

@frappe.whitelist()
def save_truck_meta(trucks_json):
    """Persist truck metadata (driver name, capacity) so it survives page reloads."""
    _write_truck_meta(trucks_json)
    return True

@frappe.whitelist()
def get_truck_meta():
    """Return previously saved truck metadata as a JSON string."""
    return _read_truck_meta()

@frappe.whitelist()
def save_closed_trucks(closed_trucks_json):
    """Persist up to 50 most recent records (full history lives in Crystal Truck Plans)."""
    import json as _json
    records = _json.loads(closed_trucks_json) if isinstance(closed_trucks_json, str) else closed_trucks_json
    frappe.db.set_default('crystal_closed_trucks', _json.dumps((records or [])[:50]))
    frappe.db.commit()
    return True

@frappe.whitelist()
def get_closed_trucks():
    """Return the persisted closed truck records."""
    return frappe.db.get_default('crystal_closed_trucks') or '[]'


@frappe.whitelist()
def create_active_truck_plan(truck_number, driver_name='', capacity_kg=5000, trip_id=''):
    """
    Create a Draft Crystal Truck Plan immediately when a truck is added.
    The plan is submitted (dispatched) later via dispatch_and_restart_truck.
    Returns the new plan name.
    """
    doc = frappe.get_doc({
        'doctype': 'Crystal Truck Plan',
        'truck_number': truck_number,
        'driver_name': driver_name or '',
        'capacity_kg': capacity_kg or '',
        'trip_id': trip_id or '',
        'plan_date': frappe.utils.today(),
    })
    doc.insert(ignore_permissions=True)
    frappe.db.commit()
    return doc.name


@frappe.whitelist()
def get_active_truck_plans():
    """
    Return all Draft (active) Crystal Truck Plans so trucks can be recovered
    from the database if the crystal_truck_meta KV store is ever cleared.
    """
    return frappe.db.get_all(
        'Crystal Truck Plan',
        filters={'docstatus': 0},
        fields=['name', 'truck_number', 'driver_name', 'capacity_kg', 'trip_id', 'plan_date'],
        order_by='plan_date DESC',
    )

@frappe.whitelist()
def get_dispatch_precheck(trucks_json):
    """
    Batch 12. Runs before the Dispatch / Dispatch Selected buttons do anything:
    finds the submitted Delivery Note(s) of every order on each truck and
    returns the orders that have none (the page then refuses to dispatch), plus
    the route-engine options (Google is offered as the default only when one
    request covers the trip). Nothing is written.
    trucks_json = [{"truck_number", "plan_name", "orders": [sales order names]}]
    """
    import json
    from crystal_custom.crystal_customizations import dispatch_engine as engine

    trucks = json.loads(trucks_json) if isinstance(trucks_json, str) else (trucks_json or [])
    out, max_located = [], 0
    for t in trucks:
        plan_name = t.get('plan_name') or ''
        exclude = plan_name if plan_name and frappe.db.get_value('Crystal Truck Plan', plan_name, 'docstatus') == 0 else None
        dns, missing, by_so = engine.resolve_delivery_notes(t.get('orders') or [], exclude)
        summaries = engine.delivery_note_summaries(dns, exclude) if dns else {}
        located = sum(1 for s in summaries.values() if s['has_location'])
        max_located = max(max_located, located)
        out.append({
            'truck_number': t.get('truck_number'),
            'ok': not missing,
            'missing': missing,
            'located_stops': located,
            'unlocated_stops': len(summaries) - located,
            'delivery_notes': [{
                'name': s['name'], 'customer_name': s.get('customer_name'),
                'sales_orders': s.get('sales_orders', []), 'grand_total': s.get('grand_total', 0),
                'total_net_weight': s.get('total_net_weight', 0), 'has_location': s['has_location'],
            } for s in summaries.values()],
        })
    return {
        'ok': all(t['ok'] for t in out) and bool(out),
        'trucks': out,
        'routing': engine.routing_options(max_located),
    }


@frappe.whitelist()
def dispatch_and_restart_truck(plan_name, truck_number, driver_name, capacity_kg, orders_json, new_trip_id, route_provider=None):
    """
    Submit the active Draft CTP (recording the dispatched trip), then create a
    fresh Draft CTP for the same truck's next trip.

    Batch 12:
      * Every order must have a submitted Delivery Note, checked BEFORE anything
        is written; otherwise nothing happens ("Delivery Note Missing").
      * The plan's rows are the Delivery Notes (one stop per DN, the DN's
        value/weight/items: what was actually loaded), with the Sales Order ids.
      * Route + distance from Google or the Hosted engine (route_provider;
        Hosted when not given, so an older page keeps working), then fuel and
        margin, all through dispatch_engine (the same engine Reconcile uses).
      * The orders' truck flags are set here, inside the same transaction
        (the page no longer closes them in a separate parallel call).
    Handles the case where plan_name is missing (legacy truck without a plan).
    Returns {'submitted_plan', 'new_plan', 'route_provider', 'distance_km', 'warnings'}.
    """
    import json
    from crystal_custom.crystal_customizations import dispatch_engine as engine

    orders = json.loads(orders_json) if isinstance(orders_json, str) else orders_json
    so_names = [o.get('name') or o.get('sales_order') for o in (orders or []) if (o.get('name') or o.get('sales_order'))]
    if not so_names:
        frappe.throw(_('Cannot dispatch an empty truck.'))

    # Get the draft plan to submit (if any)
    plan = None
    if plan_name and frappe.db.exists('Crystal Truck Plan', plan_name):
        candidate = frappe.get_doc('Crystal Truck Plan', plan_name)
        if candidate.docstatus == 0:
            plan = candidate

    # Delivery Note rule — checked before any insert
    dns, missing, _by_so = engine.resolve_delivery_notes(so_names, plan.name if plan else None)
    if missing:
        frappe.throw(engine.missing_dn_message(missing, truck_number), title=_('Delivery Note Missing'))

    if plan is None:
        # Legacy truck with no plan (or already-submitted plan) — create one to record this trip
        plan = frappe.get_doc({
            'doctype': 'Crystal Truck Plan',
            'truck_number': truck_number,
            'driver_name':  driver_name or '',
            'capacity_kg':  capacity_kg or '',
            'plan_date':    frappe.utils.today(),
        })
        plan.insert(ignore_permissions=True)
    elif capacity_kg and not plan.capacity_kg:
        plan.capacity_kg = capacity_kg

    provider = route_provider if route_provider in engine.PROVIDERS else engine.PROVIDER_HOSTED
    result = engine.build_dispatch(plan, dns, provider, engine.SOURCE_TRUCK_ASSIGNMENT)
    plan.closed_from = 'Truck Assignment'
    plan.save(ignore_permissions=True)
    plan.submit()
    submitted_name = plan.name

    engine.sync_sales_orders(plan)

    # Create fresh Draft CTP for the truck's next trip
    new_plan = frappe.get_doc({
        'doctype': 'Crystal Truck Plan',
        'truck_number': truck_number,
        'driver_name':  driver_name or '',
        'capacity_kg':  capacity_kg or '',
        'trip_id':      new_trip_id or '',
        'plan_date':    frappe.utils.today(),
    })
    new_plan.insert(ignore_permissions=True)
    frappe.db.commit()

    return {
        'submitted_plan': submitted_name,
        'new_plan': new_plan.name,
        'route_provider': result['route_provider'],
        'distance_km': result['distance_km'],
        'warnings': result['warnings'],
    }


@frappe.whitelist()
def update_truck_plan_meta(plan_name, truck_number=None, driver_name=None, capacity_kg=None, trip_id=None):
    """Update metadata fields on a Draft Crystal Truck Plan (e.g. after edit_truck_details)."""
    if not plan_name or not frappe.db.exists('Crystal Truck Plan', plan_name):
        return False
    doc = frappe.get_doc('Crystal Truck Plan', plan_name)
    if doc.docstatus != 0:
        return False  # Don't mutate submitted plans
    changed = False
    if truck_number is not None:
        doc.truck_number = truck_number; changed = True
    if driver_name is not None:
        doc.driver_name = driver_name; changed = True
    if capacity_kg is not None:
        doc.capacity_kg = capacity_kg; changed = True
    if trip_id is not None:
        doc.trip_id = trip_id; changed = True
    if changed:
        doc.save(ignore_permissions=True)
        frappe.db.commit()
    return True


@frappe.whitelist()
def get_truck_history(limit=100):
    """
    Return dispatched trip records for the Trip History panel.
    Primary source: submitted Crystal Truck Plans (docstatus=1).
    Also merges legacy crystal_closed_trucks KV records that pre-date CTP tracking.
    """
    import json

    plans = frappe.db.get_all(
        'Crystal Truck Plan',
        filters={'docstatus': 1},
        fields=['name', 'truck_number', 'driver_name', 'capacity_kg', 'trip_id',
                'plan_date', 'order_count', 'total_weight', 'total_value', 'delivery_regions'],
        order_by='plan_date DESC',
        limit=int(limit),
    )

    result = []
    for p in plans:
        orders = frappe.db.get_all(
            'Crystal Truck Plan Order',
            filters={'parent': p.name},
            fields=['sales_order as name', 'customer_name', 'delivery_region',
                    'grand_total', 'total_net_weight'],
        )
        entry          = dict(p)
        entry['orders']    = [dict(o) for o in orders]
        entry['closed_at'] = str(p.plan_date)
        result.append(entry)

    # Merge legacy KV records (trips closed before CTP tracking was introduced)
    existing_trip_ids = {r.get('trip_id') for r in result if r.get('trip_id')}
    for leg in json.loads(frappe.db.get_default('crystal_closed_trucks') or '[]'):
        if not leg.get('trip_id') or leg['trip_id'] not in existing_trip_ids:
            result.append(leg)

    return result


@frappe.whitelist()
def create_truck_plan(truck_number, driver_name, capacity_kg, orders_json, closed_from):
    """Create and submit a Crystal Truck Plan for permanent data persistence."""
    import json
    orders = json.loads(orders_json)

    doc = frappe.get_doc({
        'doctype': 'Crystal Truck Plan',
        'truck_number': truck_number,
        'plan_date': frappe.utils.today(),
        'driver_name': driver_name or '',
        'capacity_kg': capacity_kg or '',
        'closed_from': closed_from,
        'orders': [
            {
                'doctype': 'Crystal Truck Plan Order',
                'sales_order': o.get('name') or o.get('sales_order', ''),
                'customer_name': o.get('customer_name', ''),
                'delivery_region': o.get('delivery_region') or o.get('custom_delivery_region', ''),
                'grand_total': float(o.get('grand_total', 0)),
                'total_net_weight': float(o.get('total_net_weight', 0)),
            }
            for o in orders
        ],
    })
    doc.insert(ignore_permissions=True)
    doc.submit()
    frappe.db.commit()
    return doc.name


@frappe.whitelist()
def check_and_auto_close_trucks():
    """
    Check every active truck. If ALL assigned submitted orders are fully
    delivered (per_delivered >= 100) AND fully billed (per_billed >= 100),
    auto-close the truck: mark orders custom_truck_closed=1, prepend a
    closure record to crystal_closed_trucks, and remove from crystal_truck_meta.
    Returns a list of truck numbers that were auto-closed.
    """
    import json
    from collections import defaultdict

    rows = frappe.db.sql("""
        SELECT
            custom_truck_number,
            name,
            customer_name,
            custom_delivery_region,
            IFNULL(per_delivered,    0) AS per_delivered,
            IFNULL(per_billed,       0) AS per_billed,
            IFNULL(total_net_weight, 0) AS total_net_weight,
            IFNULL(grand_total,      0) AS grand_total
        FROM `tabSales Order`
        WHERE docstatus = 1
          AND custom_truck_number IS NOT NULL
          AND custom_truck_number != ''
          AND IFNULL(custom_truck_closed, 0) != 1
          AND IFNULL(custom_truck_dispatched, 0) != 1
    """, as_dict=1)

    if not rows:
        return []

    trucks = defaultdict(list)
    for r in rows:
        trucks[r.custom_truck_number].append(r)

    to_close = [
        (tn, orders) for tn, orders in trucks.items()
        if all(float(o.per_delivered) >= 100 and float(o.per_billed) >= 100 for o in orders)
    ]

    if not to_close:
        return []

    existing_closed = json.loads(frappe.db.get_default('crystal_closed_trucks') or '[]')
    existing_meta   = json.loads(_read_truck_meta())

    import random, string
    def _gen_trip_id():
        chars = string.ascii_uppercase + string.digits
        return 'TRP-' + ''.join(random.choices(chars, k=6))

    auto_closed = []
    for truck_num, orders in to_close:
        for o in orders:
            frappe.db.set_value('Sales Order', o.name, 'custom_truck_closed', 1)

        meta       = next((m for m in existing_meta if m.get('truck_number') == truck_num), {})
        old_trip   = meta.get('trip_id', '')
        new_trip   = _gen_trip_id()

        # Submit the existing Draft CTP (or create one) to record this auto-closed trip
        existing_plans = frappe.db.get_all(
            'Crystal Truck Plan',
            filters={'truck_number': truck_num, 'docstatus': 0},
            fields=['name'],
            order_by='creation DESC',
            limit=1,
        )
        if existing_plans:
            plan = frappe.get_doc('Crystal Truck Plan', existing_plans[0].name)
        else:
            plan = frappe.get_doc({
                'doctype':     'Crystal Truck Plan',
                'truck_number': truck_num,
                'driver_name':  meta.get('driver_name', ''),
                'capacity_kg':  meta.get('capacity_kg', '') or '',
                'trip_id':      old_trip,
                'plan_date':    frappe.utils.today(),
            })
            plan.insert(ignore_permissions=True)

        plan.orders = []
        for o in orders:
            plan.append('orders', {
                'sales_order':    o.name,
                'customer_name':  o.customer_name or '',
                'delivery_region': o.custom_delivery_region or '',
                'grand_total':    float(o.grand_total),
                'total_net_weight': float(o.total_net_weight),
            })
        plan.order_count  = len(orders)
        plan.total_weight = sum(float(o.total_net_weight) for o in orders)
        plan.total_value  = sum(float(o.grand_total)      for o in orders)
        plan.closed_from  = 'Auto-Close'
        plan.save(ignore_permissions=True)
        plan.submit()

        # Create a fresh Draft CTP so the truck stays active for its next trip
        new_plan = frappe.get_doc({
            'doctype':     'Crystal Truck Plan',
            'truck_number': truck_num,
            'driver_name':  meta.get('driver_name', ''),
            'capacity_kg':  meta.get('capacity_kg', '') or '',
            'trip_id':      new_trip,
            'plan_date':    frappe.utils.today(),
        })
        new_plan.insert(ignore_permissions=True)

        # Update the truck's meta entry with the new trip_id and plan (keep truck active)
        for m in existing_meta:
            if m.get('truck_number') == truck_num:
                m['trip_id']   = new_trip
                m['plan_name'] = new_plan.name
                break

        # Only keep a compact record in the KV cache — full data is in the CTP
        existing_closed.insert(0, {
            'truck_number': truck_num,
            'driver_name':  meta.get('driver_name', ''),
            'capacity_kg':  meta.get('capacity_kg', 0),
            'trip_id':      old_trip,
            'closed_at':    str(frappe.utils.now_datetime()),
            'order_count':  len(orders),
            'total_weight': sum(float(o.total_net_weight) for o in orders),
            'total_value':  sum(float(o.grand_total)      for o in orders),
            'auto_closed':  True,
            'orders': [
                {'name': o.name, 'customer_name': o.customer_name or '',
                 'delivery_region': o.custom_delivery_region or ''}
                for o in orders
            ],
        })
        auto_closed.append(truck_num)

    # Cap KV cache at 50 entries — older records live permanently in Crystal Truck Plans
    frappe.db.set_default('crystal_closed_trucks', json.dumps(existing_closed[:50]))
    _write_truck_meta(json.dumps(existing_meta))
    frappe.db.commit()
    return auto_closed


@frappe.whitelist()
def cleanup_stale_completed_orders():
    """
    One-shot cleanup: mark all truck-assigned Completed/Closed orders as custom_truck_closed=1
    so they stop appearing on active trucks. Safe to run multiple times.
    """
    result = frappe.db.sql("""
        UPDATE `tabSales Order`
        SET custom_truck_closed = 1
        WHERE custom_truck_number IS NOT NULL
          AND custom_truck_number != ''
          AND IFNULL(custom_truck_closed, 0) != 1
          AND status IN ('Completed', 'Closed')
    """)
    frappe.db.commit()
    count = frappe.db.sql("SELECT ROW_COUNT()")[0][0]
    frappe.logger().info(f"cleanup_stale_completed_orders: marked {count} orders as truck_closed")
    return {'updated': count}


