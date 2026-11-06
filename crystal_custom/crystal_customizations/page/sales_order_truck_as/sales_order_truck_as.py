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
def dispatch_and_restart_truck(plan_name, truck_number, driver_name, capacity_kg, orders_json, new_trip_id):
    """
    Submit the active Draft CTP (recording the dispatched trip with all its orders),
    then create a fresh Draft CTP for the same truck's next trip.
    Handles the case where plan_name is missing (legacy truck without a plan).
    Returns {'submitted_plan': name, 'new_plan': name}.
    """
    import json
    orders = json.loads(orders_json) if isinstance(orders_json, str) else orders_json

    def _fill_orders(plan_doc, order_list):
        plan_doc.orders = []
        for o in order_list:
            plan_doc.append('orders', {
                'sales_order':    o.get('name') or o.get('sales_order', ''),
                'customer_name':  o.get('customer_name', ''),
                'delivery_region': o.get('delivery_region') or o.get('custom_delivery_region', ''),
                'grand_total':    float(o.get('grand_total', 0)),
                'total_net_weight': float(o.get('total_net_weight', 0)),
            })
        plan_doc.order_count  = len(order_list)
        plan_doc.total_weight = sum(float(o.get('total_net_weight', 0)) for o in order_list)
        plan_doc.total_value  = sum(float(o.get('grand_total', 0))      for o in order_list)
        regions = sorted({
            o.get('custom_delivery_region') or o.get('delivery_region', '')
            for o in order_list
            if o.get('custom_delivery_region') or o.get('delivery_region')
        })
        plan_doc.delivery_regions = ', '.join(r for r in regions if r)
        plan_doc.closed_from = 'Truck Assignment'

    # Get or create the draft plan to submit
    plan = None
    if plan_name and frappe.db.exists('Crystal Truck Plan', plan_name):
        candidate = frappe.get_doc('Crystal Truck Plan', plan_name)
        if candidate.docstatus == 0:
            plan = candidate

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

    _fill_orders(plan, orders)
    plan.save(ignore_permissions=True)

    # ── Silent authoritative recompute — route/fuel/margin, regardless of
    # whatever the client last showed via Optimize Route / Analyse Margins.
    computed = _compute_route_and_margin_for_dispatch(plan)
    plan.approximate_total_distance_km    = computed["distance_km"] or 0.0
    plan.approximate_trip_duration        = computed["duration_seconds"] or 0
    plan.approximate_fuel_consumption_ltrs = computed["fuel_litres"] or 0.0
    plan.approximate_fuel_cost            = computed["fuel_cost"] or 0.0
    plan.route_geojson                    = computed["route_geojson"] or ""

    margin = computed["margin"] or {}
    plan.total_order_value                     = margin.get("total_order_value", 0.0)
    plan.total_theoretical_cost                = margin.get("total_theoretical_cost", 0.0)
    plan.narrowed_gross_profit                 = margin.get("narrowed_gross_profit", 0.0)
    plan.narrowed_gross_margin_percentage      = margin.get("narrowed_gross_margin_percentage", 0.0)
    threshold = flt(frappe.db.get_single_value("Crystal Fleet Settings", "narrowed_margin_profitability_threshold")) or 33.0
    plan.profitability_status = "Profitable" if plan.narrowed_gross_margin_percentage >= threshold else "Loss"

    plan.save(ignore_permissions=True)
    plan.submit()
    submitted_name = plan.name

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

    return {'submitted_plan': submitted_name, 'new_plan': new_plan.name}


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

