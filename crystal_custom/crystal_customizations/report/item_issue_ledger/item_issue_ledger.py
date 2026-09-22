# Copyright (c) 2026, wangui and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.utils import flt


def execute(filters=None):
	filters = filters or {}
	columns = get_columns()
	data    = get_data(filters)
	return columns, data


def get_columns():
	return [
		{"label": _("Date"),          "fieldname": "issue_date",  "fieldtype": "Date",                            "width": 95},
		{"label": _("Item"),          "fieldname": "item",        "fieldtype": "Link",   "options": "Item",       "width": 140},
		{"label": _("Item Name"),     "fieldname": "item_name",   "fieldtype": "Data",                            "width": 180},
		{"label": _("UOM"),           "fieldname": "uom",         "fieldtype": "Link",   "options": "UOM",        "width": 70},
		{"label": _("Type"),          "fieldname": "entry_type",  "fieldtype": "Data",                            "width": 90},
		{"label": _("Receipt Qty"),   "fieldname": "receipt_qty", "fieldtype": "Float",   "convertible": "qty",   "width": 100},
		{"label": _("Issue Qty"),     "fieldname": "issue_qty",   "fieldtype": "Float",   "convertible": "qty",   "width": 100},
		{"label": _("Balance Qty"),   "fieldname": "balance",     "fieldtype": "Float",   "convertible": "qty",   "width": 110},
		{"label": _("Entry No"),      "fieldname": "name",        "fieldtype": "Link",   "options": "Item Issue", "width": 120},
		{"label": _("Issued To"),     "fieldname": "issued_to",   "fieldtype": "Data",                            "width": 140},
		{"label": _("Remarks"),       "fieldname": "remarks",     "fieldtype": "Data",                            "width": 200},
	]


def get_data(filters):
	# from_date is deliberately NOT applied in SQL — it's used below to split
	# history into an opening balance (everything before it) and the rows shown,
	# so "Balance Qty" is always the true running balance rather than resetting
	# to 0 at the start of whatever date range is filtered.
	conditions = ["ii.docstatus = 1"]
	params = {}

	if filters.get("to_date"):
		conditions.append("ii.issue_date <= %(to_date)s")
		params["to_date"] = filters["to_date"]
	if filters.get("item"):
		conditions.append("ii.item = %(item)s")
		params["item"] = filters["item"]
	if filters.get("entry_type"):
		conditions.append("IFNULL(ii.entry_type, 'Issue') = %(entry_type)s")
		params["entry_type"] = filters["entry_type"]
	if filters.get("issued_to"):
		conditions.append("ii.issued_to LIKE %(issued_to)s")
		params["issued_to"] = f"%{filters['issued_to']}%"

	where_clause = " AND ".join(conditions)

	rows = frappe.db.sql(f"""
		SELECT
			ii.name, ii.item, ii.item_name,
			IFNULL(ii.entry_type, 'Issue') AS entry_type,
			ii.qty, ii.uom,
			ii.issue_date, ii.issued_to, ii.remarks
		FROM `tabItem Issue` ii
		WHERE {where_clause}
		ORDER BY ii.item ASC, ii.issue_date ASC, ii.creation ASC
	""", params, as_dict=1)

	from_date = filters.get("from_date")
	item_meta = {}
	for row in rows:
		item_meta.setdefault(row.item, {"item_name": row.item_name, "uom": row.uom})

	# Build ledger rows with a running balance per item, seeding an "Opening"
	# anchor row (like Stock Ledger's Opening Qty) the first time each item
	# crosses into the filtered date range.
	balances = {}
	opening_emitted = set()
	result = []

	for row in rows:
		item  = row.item
		qty   = flt(row.qty)
		etype = row.entry_type
		before_range = bool(from_date and row.issue_date and str(row.issue_date) < str(from_date))

		opening_balance = balances.get(item, 0)
		balances[item] = opening_balance + qty if etype == 'Receipt' else opening_balance - qty

		if before_range:
			continue

		if from_date and item not in opening_emitted:
			opening_emitted.add(item)
			meta = item_meta[item]
			result.append({
				'name':        None,
				'issue_date':  from_date,
				'entry_type':  'Opening',
				'item':        item,
				'item_name':   meta['item_name'],
				'receipt_qty': None,
				'issue_qty':   None,
				'balance':     opening_balance,
				'uom':         meta['uom'],
				'issued_to':   None,
				'remarks':     None,
			})

		result.append({
			'name':        row.name,
			'issue_date':  row.issue_date,
			'entry_type':  etype,
			'item':        item,
			'item_name':   row.item_name,
			'receipt_qty': qty if etype == 'Receipt' else None,
			'issue_qty':   qty if etype != 'Receipt' else None,
			'balance':     balances[item],
			'uom':         row.uom,
			'issued_to':   row.issued_to,
			'remarks':     row.remarks,
		})

	return result
