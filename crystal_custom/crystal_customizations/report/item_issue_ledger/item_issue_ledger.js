// Copyright (c) 2026, wangui and contributors
// For license information, please see license.txt

frappe.query_reports["Item Issue Ledger"] = {
	filters: [
		{
			fieldname: "from_date",
			label: __("From Date"),
			fieldtype: "Date",
			default: frappe.datetime.add_months(frappe.datetime.get_today(), -1),
		},
		{
			fieldname: "to_date",
			label: __("To Date"),
			fieldtype: "Date",
			default: frappe.datetime.get_today(),
		},
		{
			fieldname: "item",
			label: __("Item"),
			fieldtype: "Link",
			options: "Item",
		},
		{
			fieldname: "entry_type",
			label: __("Entry Type"),
			fieldtype: "Select",
			options: "\nReceipt\nIssue",
		},
		{
			fieldname: "issued_to",
			label: __("Issued To"),
			fieldtype: "Data",
		},
	],

	formatter: function (value, row, column, data, default_formatter) {
		value = default_formatter(value, row, column, data);
		if (!data) return value;

		if (data.entry_type === "Opening") {
			return `<span style="color:#94a3b8;font-style:italic;">${value}</span>`;
		}
		if (column.fieldname === "receipt_qty" && data.receipt_qty) {
			return `<span style="color:#16a34a;font-weight:600;">${value}</span>`;
		}
		if (column.fieldname === "issue_qty" && data.issue_qty) {
			return `<span style="color:#dc2626;font-weight:600;">${value}</span>`;
		}
		if (column.fieldname === "entry_type") {
			const color = data.entry_type === "Receipt" ? "#16a34a" : "#dc2626";
			return `<span style="color:${color};font-weight:600;">${value}</span>`;
		}
		if (column.fieldname === "balance") {
			return `<span style="font-weight:600;">${value}</span>`;
		}
		return value;
	},
};
