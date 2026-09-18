import frappe
from frappe import _

FINANCE_APPROVED_STATES = ('Pending Customer Order Reconfirmation', 'Order Confirmed')
STOCK_WAREHOUSE = 'Finished Goods - CAL'

_NOTES_COL_CACHE = None

def _get_notes_col():
    """Return the SO column used for paint/colour notes, or None if absent."""
    global _NOTES_COL_CACHE
    if _NOTES_COL_CACHE is not None:
        return _NOTES_COL_CACHE or None
    for candidate in ('custom_additonal_notes', 'custom_additional_notes', 'custom_paint_notes'):
        if frappe.db.has_column('Sales Order', candidate):
            _NOTES_COL_CACHE = candidate
            return candidate
    _NOTES_COL_CACHE = ''
    return None


@frappe.whitelist()
def get_sales_order_fulfillment(from_date=None, to_date=None):
    """
    Aggregate all finance-approved orders vs finished goods stock.
    Used by the Item Summary tab.
    """
    conditions = [
        "so.workflow_state IN %(states)s",
        "so.status NOT IN ('Completed', 'Closed')",
        "soi.qty > soi.delivered_qty",
    ]
    params = {'states': FINANCE_APPROVED_STATES}

    if from_date:
        conditions.append("so.transaction_date >= %(from_date)s")
        params['from_date'] = from_date
    if to_date:
        conditions.append("so.transaction_date <= %(to_date)s")
        params['to_date'] = to_date

    where_clause = " AND ".join(conditions)

    sales_order_items = frappe.db.sql(f"""
        SELECT
            soi.item_code,
            soi.item_name,
            SUM(soi.qty - soi.delivered_qty) as required_qty
        FROM `tabSales Order Item` soi
        INNER JOIN `tabSales Order` so ON soi.parent = so.name
        WHERE {where_clause}
        GROUP BY soi.item_code, soi.item_name
    """, params, as_dict=1)

    result = []
    for item in sales_order_items:
        available_qty = frappe.db.sql("""
            SELECT IFNULL(SUM(actual_qty), 0) as available_qty
            FROM `tabBin`
            WHERE item_code = %s AND warehouse = %s
        """, (item.item_code, STOCK_WAREHOUSE), as_dict=1)[0].available_qty

        shortage = item.required_qty - available_qty
        result.append({
            'item_code':    item.item_code,
            'item_name':    item.item_name,
            'required_qty': item.required_qty,
            'available_qty': available_qty,
            'shortage':     max(shortage, 0),
        })

    return sorted(result, key=lambda x: x['shortage'], reverse=True)


@frappe.whitelist()
def get_truck_fulfillment_data():
    """
    Return items grouped by truck — NOT date-filtered so the truck list always
    matches truck assignment. Includes closed trucks (is_closed=True).
    Stock is always current (from tabBin at call time).
    """
    ACTIVE_WORKFLOW = ('Pending Finance Approval',
                       'Pending Customer Order Reconfirmation',
                       'Order Confirmed')

    _notes_col = _get_notes_col()
    _notes_expr = f'so.`{_notes_col}`' if _notes_col else "''"

    rows = frappe.db.sql(f"""
        SELECT
            so.custom_truck_number                                          AS truck_number,
            so.name                                                         AS sales_order,
            so.customer_name,
            {_notes_expr}                                                   AS custom_paint_notes,
            so.custom_delivery_region,
            (SELECT GROUP_CONCAT(DISTINCT st.sales_person ORDER BY st.sales_person SEPARATOR ', ')
             FROM `tabSales Team` st WHERE st.parent = so.name)            AS sales_persons,
            soi.item_code,
            soi.item_name,
            GREATEST(0, SUM(soi.qty - IFNULL(soi.delivered_qty, 0)))       AS required_qty,
            soi.uom,
            IFNULL(soi.weight_per_unit, 0)                                  AS weight_per_unit
        FROM `tabSales Order` so
        INNER JOIN `tabSales Order Item` soi ON soi.parent = so.name
        WHERE so.docstatus IN (0, 1)
          AND so.workflow_state IN %(wf)s
          AND so.status NOT IN ('Completed', 'Closed')
          AND so.custom_truck_number IS NOT NULL
          AND so.custom_truck_number != ''
          AND IFNULL(so.custom_truck_closed, 0) != 1
        GROUP BY so.custom_truck_number, so.name, soi.item_code
        ORDER BY so.custom_truck_number, soi.item_code
    """, {'wf': ACTIVE_WORKFLOW}, as_dict=1)

    if not rows:
        return {'trucks': [], 'stock': {}}

    unique_items = list({r.item_code for r in rows if float(r.required_qty) > 0})
    stock_map  = {}
    if unique_items:
        item_ph = ', '.join(['%s'] * len(unique_items))
        stock_rows = frappe.db.sql(
            f"SELECT item_code, IFNULL(SUM(actual_qty),0) AS available_qty "
            f"FROM `tabBin` WHERE item_code IN ({item_ph}) AND warehouse = %s GROUP BY item_code",
            unique_items + [STOCK_WAREHOUSE], as_dict=1,
        )
        stock_map = {s.item_code: float(s.available_qty) for s in stock_rows}
    item_names = {r.item_code: r.item_name for r in rows}
    item_uoms  = {r.item_code: r.uom       for r in rows}

    from collections import defaultdict
    trucks_map = defaultdict(lambda: {'orders': {}, 'items': defaultdict(float)})
    for r in rows:
        tn = r.truck_number
        trucks_map[tn]['orders'][r.sales_order] = {
            'name':            r.sales_order,
            'customer_name':   r.customer_name or r.sales_order,
            'paint_notes':     r.custom_paint_notes or '',
            'delivery_region': r.custom_delivery_region or '',
            'sales_persons':   r.sales_persons or '',
        }
        if float(r.required_qty) > 0:
            trucks_map[tn]['items'][r.item_code] += float(r.required_qty)

    meta_rows = frappe.db.sql("""
        SELECT
            so.custom_truck_number   AS truck_number,
            SUM(so.total_net_weight) AS total_weight,
            SUM(so.grand_total)      AS total_value,
            COUNT(so.name)           AS order_count,
            GROUP_CONCAT(DISTINCT so.custom_delivery_region
                         ORDER BY so.custom_delivery_region
                         SEPARATOR ', ')            AS delivery_regions
        FROM `tabSales Order` so
        WHERE so.docstatus IN (0, 1)
          AND so.workflow_state IN %(wf)s
          AND so.status NOT IN ('Completed', 'Closed')
          AND so.custom_truck_number IS NOT NULL
          AND so.custom_truck_number != ''
          AND IFNULL(so.custom_truck_closed, 0) != 1
        GROUP BY so.custom_truck_number
    """, {'wf': ACTIVE_WORKFLOW}, as_dict=1)
    meta_map = {r.truck_number: r for r in meta_rows}

    trucks = []
    for tn in sorted(trucks_map.keys()):
        data = trucks_map[tn]
        meta = meta_map.get(tn, {})
        trucks.append({
            'truck_number':     tn,
            'order_count':      len(data['orders']),
            'orders':           list(data['orders'].values()),
            'total_weight':     float(meta.get('total_weight') or 0),
            'total_value':      float(meta.get('total_value')  or 0),
            'delivery_regions': meta.get('delivery_regions') or '',
            'items': [
                {
                    'item_code':    ic,
                    'item_name':    item_names.get(ic, ic),
                    'required_qty': qty,
                    'uom':          item_uoms.get(ic, ''),
                }
                for ic, qty in sorted(data['items'].items())
            ],
        })

    stock = {
        ic: {
            'available_qty': stock_map.get(ic, 0),
            'item_name':     item_names.get(ic, ic),
            'uom':           item_uoms.get(ic, ''),
        }
        for ic in unique_items
    }

    return {'trucks': trucks, 'stock': stock}


@frappe.whitelist()
def get_truck_customer_data():
    """
    Return per-order item breakdown grouped by truck — NOT date-filtered.
    Includes closed trucks. Stock is always current.
    Used by the Customer View tab.
    """
    ACTIVE_WORKFLOW = ('Pending Finance Approval',
                       'Pending Customer Order Reconfirmation',
                       'Order Confirmed')

    _notes_col = _get_notes_col()
    _notes_expr = f'so.`{_notes_col}`' if _notes_col else "''"

    rows = frappe.db.sql(f"""
        SELECT
            so.custom_truck_number                                          AS truck_number,
            so.name                                                         AS sales_order,
            so.customer,
            so.customer_name,
            so.grand_total,
            so.total_net_weight,
            {_notes_expr}                                                   AS custom_paint_notes,
            soi.item_code,
            soi.item_name,
            GREATEST(0, SUM(soi.qty - IFNULL(soi.delivered_qty, 0)))       AS required_qty,
            soi.uom
        FROM `tabSales Order` so
        INNER JOIN `tabSales Order Item` soi ON soi.parent = so.name
        WHERE so.docstatus IN (0, 1)
          AND so.workflow_state IN %(wf)s
          AND so.status NOT IN ('Completed', 'Closed')
          AND so.custom_truck_number IS NOT NULL
          AND so.custom_truck_number != ''
          AND IFNULL(so.custom_truck_closed, 0) != 1
        GROUP BY so.custom_truck_number, so.name, soi.item_code
        ORDER BY so.custom_truck_number, so.customer_name, so.name, soi.item_code
    """, {'wf': ACTIVE_WORKFLOW}, as_dict=1)

    if not rows:
        return {'trucks': [], 'stock': {}}

    unique_items = list({r.item_code for r in rows if float(r.required_qty) > 0})
    stock_map = {}
    if unique_items:
        item_ph = ', '.join(['%s'] * len(unique_items))
        stock_rows = frappe.db.sql(
            f"SELECT item_code, IFNULL(SUM(actual_qty), 0) AS available_qty "
            f"FROM `tabBin` WHERE item_code IN ({item_ph}) AND warehouse = %s GROUP BY item_code",
            unique_items + [STOCK_WAREHOUSE], as_dict=1,
        )
        stock_map = {s.item_code: float(s.available_qty) for s in stock_rows}

    from collections import OrderedDict
    trucks_map = OrderedDict()
    for r in rows:
        tn = r.truck_number
        on = r.sales_order
        if tn not in trucks_map:
            trucks_map[tn] = OrderedDict()
        if on not in trucks_map[tn]:
            trucks_map[tn][on] = {
                'name':             on,
                'customer':         r.customer,
                'customer_name':    r.customer_name or on,
                'grand_total':      float(r.grand_total or 0),
                'total_net_weight': float(r.total_net_weight or 0),
                'paint_notes':      r.custom_paint_notes or '',
                'items':            [],
            }
        if float(r.required_qty) > 0:
            trucks_map[tn][on]['items'].append({
                'item_code':    r.item_code,
                'item_name':    r.item_name,
                'required_qty': float(r.required_qty),
                'uom':          r.uom,
            })

    trucks = []
    for tn, orders_dict in trucks_map.items():
        trucks.append({
            'truck_number': tn,
            'orders':       list(orders_dict.values()),
        })

    stock = {ic: float(stock_map.get(ic, 0)) for ic in unique_items}
    return {'trucks': trucks, 'stock': stock}


@frappe.whitelist()
def get_region_fulfillment_data(regions_json=None):
    """
    Return items for orders marked as Pre-Fulfilment (custom_is_pre_fulfillment=1)
    that have no truck assigned yet. Grouped by delivery region as virtual truck cards.
    The regions_json parameter is kept for backwards compatibility but is no longer
    used — the custom_is_pre_fulfillment flag on the Sales Order is the source of truth.
    """
    if not frappe.db.has_column('Sales Order', 'custom_is_pre_fulfillment'):
        return {'trucks': [], 'stock': {}}

    ACTIVE_WORKFLOW = ('Pending Finance Approval',
                       'Pending Customer Order Reconfirmation',
                       'Order Confirmed')

    _notes_col = _get_notes_col()
    _notes_expr = f'so.`{_notes_col}`' if _notes_col else "''"

    rows = frappe.db.sql(f"""
        SELECT
            so.custom_delivery_region                                       AS delivery_region,
            so.name                                                         AS sales_order,
            so.customer_name,
            {_notes_expr}                                                   AS custom_paint_notes,
            (SELECT GROUP_CONCAT(DISTINCT st.sales_person ORDER BY st.sales_person SEPARATOR ', ')
             FROM `tabSales Team` st WHERE st.parent = so.name)            AS sales_persons,
            soi.item_code,
            soi.item_name,
            GREATEST(0, SUM(soi.qty - IFNULL(soi.delivered_qty, 0)))       AS required_qty,
            soi.uom,
            IFNULL(soi.weight_per_unit, 0)                                  AS weight_per_unit
        FROM `tabSales Order` so
        INNER JOIN `tabSales Order Item` soi ON soi.parent = so.name
        WHERE so.docstatus IN (0, 1)
          AND so.workflow_state IN %(wf)s
          AND so.status NOT IN ('Completed', 'Closed')
          AND (so.custom_truck_number IS NULL OR so.custom_truck_number = '')
          AND IFNULL(so.custom_is_pre_fulfillment, 0) = 1
        GROUP BY so.custom_delivery_region, so.name, soi.item_code
        ORDER BY so.custom_delivery_region, soi.item_code
    """, {'wf': ACTIVE_WORKFLOW}, as_dict=1)

    if not rows:
        return {'trucks': [], 'stock': {}}

    unique_items = list({r.item_code for r in rows if float(r.required_qty) > 0})
    stock_map = {}
    if unique_items:
        item_ph = ', '.join(['%s'] * len(unique_items))
        stock_rows = frappe.db.sql(
            f"SELECT item_code, IFNULL(SUM(actual_qty),0) AS available_qty "
            f"FROM `tabBin` WHERE item_code IN ({item_ph}) AND warehouse = %s GROUP BY item_code",
            unique_items + [STOCK_WAREHOUSE], as_dict=1,
        )
        stock_map = {s.item_code: float(s.available_qty) for s in stock_rows}
    item_names = {r.item_code: r.item_name for r in rows}
    item_uoms  = {r.item_code: r.uom       for r in rows}

    from collections import defaultdict
    buckets = defaultdict(lambda: {
        'orders': {}, 'items': defaultdict(float),
        'order_items': defaultdict(lambda: defaultdict(float)),
    })
    for r in rows:
        region = r.delivery_region or 'Unknown'
        if r.sales_order not in buckets[region]['orders']:
            buckets[region]['orders'][r.sales_order] = {
                'name':            r.sales_order,
                'customer_name':   r.customer_name or r.sales_order,
                'paint_notes':     r.custom_paint_notes or '',
                'delivery_region': r.custom_delivery_region or '',
                'sales_persons':   r.sales_persons or '',
            }
        if float(r.required_qty) > 0:
            buckets[region]['items'][r.item_code] += float(r.required_qty)
            buckets[region]['order_items'][r.sales_order][r.item_code] = float(r.required_qty)

    trucks = []
    for region in sorted(buckets.keys()):
        data = buckets[region]
        virtual_truck_number = f'\U0001f4cd {region}'
        orders_with_items = [
            {
                **order_data,
                'items': [
                    {'item_code': ic, 'required_qty': qty}
                    for ic, qty in data['order_items'].get(on, {}).items()
                ],
            }
            for on, order_data in data['orders'].items()
        ]
        trucks.append({
            'truck_number':     virtual_truck_number,
            'is_region_bucket': True,
            'region_label':     region,
            'order_count':      len(data['orders']),
            'orders':           orders_with_items,
            'total_weight':     0,
            'total_value':      0,
            'delivery_regions': region,
            'items': [
                {
                    'item_code':    ic,
                    'item_name':    item_names.get(ic, ic),
                    'required_qty': qty,
                    'uom':          item_uoms.get(ic, ''),
                }
                for ic, qty in sorted(data['items'].items())
            ],
        })

    stock = {
        ic: {
            'available_qty': stock_map.get(ic, 0),
            'item_name':     item_names.get(ic, ic),
            'uom':           item_uoms.get(ic, ''),
        }
        for ic in unique_items
    }
    return {'trucks': trucks, 'stock': stock}


@frappe.whitelist()
def close_truck(truck_number):
    """
    Manually close a truck from the Order Fulfillment page:
    set custom_truck_closed=1 on all its orders and record it in
    crystal_closed_trucks.
    """
    import json as _json

    orders = frappe.db.sql(
        """SELECT name, customer_name, custom_delivery_region, total_net_weight, grand_total
           FROM `tabSales Order`
           WHERE custom_truck_number = %s AND docstatus != 2""",
        truck_number, as_dict=1
    )
    for o in orders:
        frappe.db.set_value('Sales Order', o.name, 'custom_truck_closed', 1, update_modified=False)

    existing_closed = _json.loads(frappe.db.get_default('crystal_closed_trucks') or '[]')
    existing_meta   = _json.loads(frappe.db.get_default('crystal_truck_meta')    or '[]')

    # Avoid duplicate entries
    existing_closed = [ct for ct in existing_closed if ct.get('truck_number') != truck_number]
    meta = next((m for m in existing_meta if m.get('truck_number') == truck_number), {})

    existing_closed.insert(0, {
        'truck_number': truck_number,
        'driver_name':  meta.get('driver_name', ''),
        'capacity_kg':  meta.get('capacity_kg', 0),
        'closed_at':    str(frappe.utils.now_datetime()),
        'order_count':  len(orders),
        'total_weight': sum(float(o.total_net_weight or 0) for o in orders),
        'total_value':  sum(float(o.grand_total or 0)      for o in orders),
        'orders': [
            {
                'name':            o.name,
                'customer_name':   o.customer_name or '',
                'delivery_region': o.custom_delivery_region or '',
            }
            for o in orders
        ],
    })
    frappe.db.set_default('crystal_closed_trucks', _json.dumps(existing_closed))
    frappe.db.commit()
    return 'ok'


@frappe.whitelist()
def reopen_truck(truck_number):
    """
    Reopen a closed truck: set custom_truck_closed=0 on all its orders
    and remove it from the crystal_closed_trucks KV store.
    """
    import json as _json
    frappe.db.sql(
        "UPDATE `tabSales Order` SET custom_truck_closed = 0 WHERE custom_truck_number = %s",
        truck_number
    )
    # Remove from closed trucks list if present
    closed_raw = frappe.db.get_default('crystal_closed_trucks') or '[]'
    try:
        closed = _json.loads(closed_raw)
    except Exception:
        closed = []
    closed = [ct for ct in closed if ct.get('truck_number') != truck_number]
    frappe.db.set_default('crystal_closed_trucks', _json.dumps(closed))
    frappe.db.commit()
    return 'ok'


def _alloc_file_path():
    import os as _os
    path = frappe.get_site_path('private', 'files', 'crystal_fulfillment_alloc.json')
    _os.makedirs(_os.path.dirname(path), exist_ok=True)
    return path

def _ofm_closed_file_path():
    import os as _os
    path = frappe.get_site_path('private', 'files', 'crystal_ofm_closed_trucks.json')
    _os.makedirs(_os.path.dirname(path), exist_ok=True)
    return path


@frappe.whitelist()
def save_allocations(allocations_json):
    """Persist truck-item allocation map to a private site file (no size limit)."""
    import json as _json2
    allocs = _json2.loads(allocations_json) if isinstance(allocations_json, str) else allocations_json
    compact = {
        item: {truck: qty for truck, qty in trucks.items() if qty}
        for item, trucks in allocs.items()
    }
    compact = {item: trucks for item, trucks in compact.items() if trucks}
    with open(_alloc_file_path(), 'w', encoding='utf-8') as fh:
        _json2.dump(compact, fh, separators=(',', ':'), ensure_ascii=False)
    return True


@frappe.whitelist()
def get_allocations():
    """Return previously saved allocation map."""
    import json as _json2, os as _os
    path = _alloc_file_path()
    if _os.path.exists(path):
        with open(path, encoding='utf-8') as fh:
            return fh.read()
    # Fallback: migrate old defvalue store if present
    old = frappe.db.get_default('crystal_fulfillment_alloc')
    if old:
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(old)
        frappe.db.set_default('crystal_fulfillment_alloc', '')
        frappe.db.commit()
        return old
    return '{}'


@frappe.whitelist()
def save_ofm_closed_trucks(trucks_json):
    """Persist OFM closed (Done) truck numbers server-side."""
    with open(_ofm_closed_file_path(), 'w', encoding='utf-8') as fh:
        fh.write(trucks_json)
    return True


@frappe.whitelist()
def get_ofm_closed_trucks():
    """Return previously saved OFM closed truck numbers."""
    import os as _os
    path = _ofm_closed_file_path()
    if _os.path.exists(path):
        with open(path, encoding='utf-8') as fh:
            return fh.read()
    return '[]'


@frappe.whitelist()
def get_pending_mr_quantities(item_codes_json):
    """
    Return still-pending quantities per item across all active submitted MRs.
    pending = qty - ordered_qty for each MR line that hasn't been fully fulfilled.
    Used to avoid re-requesting items that are already in a pending MR.
    """
    import json
    item_codes = json.loads(item_codes_json) if isinstance(item_codes_json, str) else item_codes_json
    if not item_codes:
        return {}

    item_ph = ', '.join(['%s'] * len(item_codes))
    rows = frappe.db.sql(f"""
        SELECT
            mri.item_code,
            SUM(GREATEST(0, mri.qty - IFNULL(mri.ordered_qty, 0))) AS pending_qty
        FROM `tabMaterial Request Item` mri
        INNER JOIN `tabMaterial Request` mr ON mr.name = mri.parent
        WHERE mr.docstatus = 1
          AND mr.status NOT IN ('Stopped', 'Cancelled')
          AND mri.item_code IN ({item_ph})
        GROUP BY mri.item_code
    """, item_codes, as_dict=1)

    return {r.item_code: float(r.pending_qty) for r in rows}


@frappe.whitelist()
def create_requisition_from_shortage_items(shortage_items):
    """
    Create a draft Manufacture Material Request from a list of shortage items.
    shortage_items: JSON list of {item_code, item_name, shortage_qty, uom}
    """
    import json
    if isinstance(shortage_items, str):
        shortage_items = json.loads(shortage_items)

    items = [i for i in shortage_items if float(i.get('shortage_qty') or 0) > 0]
    if not items:
        frappe.throw(_('No shortages to requisition'))

    mr = frappe.new_doc('Material Request')
    mr.material_request_type = 'Manufacture'
    mr.transaction_date = frappe.utils.today()
    mr.schedule_date    = frappe.utils.add_days(frappe.utils.today(), 7)

    for item in items:
        mr.append('items', {
            'item_code':     item['item_code'],
            'qty':           float(item['shortage_qty']),
            'uom':           item.get('uom', ''),
            'schedule_date': mr.schedule_date,
            'warehouse':     STOCK_WAREHOUSE,
        })

    mr.insert(ignore_permissions=False)
    return mr.name


@frappe.whitelist()
def create_material_request_from_shortage(from_date=None, to_date=None):
    """Legacy: create MR from item summary shortages (Item Summary tab)."""
    fulfillment_data = get_sales_order_fulfillment(from_date=from_date, to_date=to_date)
    shortage_items = [
        {'item_code': i['item_code'], 'item_name': i['item_name'],
         'shortage_qty': i['shortage'], 'uom': ''}
        for i in fulfillment_data if i['shortage'] > 0
    ]
    return create_requisition_from_shortage_items(shortage_items)


def get_default_warehouse_for_manufacture(item_code):
    warehouse = frappe.db.get_value('Item Default', {'parent': item_code}, 'default_warehouse')
    if warehouse:
        return warehouse
    return frappe.db.get_value('Warehouse', {'is_group': 0, 'disabled': 0}, 'name')


