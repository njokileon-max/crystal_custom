// Copyright (c) 2026, Crystal Adhesives Ltd
// For license information, please see license.txt

const SPP_METHOD =
	"crystal_custom.crystal_customizations.doctype.supplier_payment_proposal.supplier_payment_proposal";

frappe.ui.form.on("Supplier Payment Proposal", {
	setup(frm) {
		frm.set_query("paid_from", () => ({
			filters: {
				company: frm.doc.company,
				is_group: 0,
				account_type: ["in", ["Bank", "Cash"]],
			},
		}));

		frm.set_query("purchase_invoice", "invoices", () => ({
			filters: {
				company: frm.doc.company,
				docstatus: 1,
				is_return: 0,
				outstanding_amount: [">", 0],
			},
		}));
	},

	onload(frm) {
		if (frm.is_new() && !frm.doc.company) {
			frm.set_value("company", frappe.defaults.get_user_default("Company"));
		}
		if (frm.is_new() && !frm.doc.payment_date) {
			frm.set_value("payment_date", frappe.datetime.get_today());
		}
	},

	refresh(frm) {
		set_intro(frm);

		if (frm.doc.docstatus === 0) {
			frm.add_custom_button(__("Get Unpaid Invoices"), () => get_unpaid_invoices(frm));
		}

		const pending = (frm.doc.invoices || []).filter((row) => !row.payment_entry);
		if (frm.doc.docstatus === 1 && pending.length && frappe.model.can_create("Payment Entry")) {
			frm.add_custom_button(__("Create Payment Entries"), () => create_payment_entries(frm)).addClass(
				"btn-primary"
			);
		}

		if (frm.doc.docstatus === 1 && pending.length < (frm.doc.invoices || []).length) {
			frm.add_custom_button(__("View Payment Entries"), () => {
				frappe.set_route("List", "Payment Entry", {
					custom_supplier_payment_proposal: frm.doc.name,
				});
			});
		}
	},

	company(frm) {
		if (!frm.doc.company) return;
		frappe.db.get_value("Company", frm.doc.company, "default_bank_account").then((r) => {
			frm.set_value("paid_from", (r.message && r.message.default_bank_account) || "");
		});
	},
});

frappe.ui.form.on("Supplier Payment Proposal Invoice", {
	purchase_invoice(frm, cdt, cdn) {
		const row = locals[cdt][cdn];
		if (!row.purchase_invoice) return;

		frappe
			.call(`${SPP_METHOD}.get_invoice_details`, { purchase_invoice: row.purchase_invoice })
			.then((r) => {
				const pi = r.message;
				frappe.model.set_value(cdt, cdn, {
					supplier: pi.supplier,
					supplier_name: pi.supplier_name,
					bill_no: pi.bill_no,
					posting_date: pi.posting_date,
					due_date: pi.due_date,
					currency: pi.currency,
					party_account: pi.party_account,
					grand_total: pi.grand_total,
					outstanding_amount: pi.outstanding_amount,
					amount_to_pay: pi.amount_to_pay,
				});
			});
	},

	amount_to_pay(frm) {
		set_totals(frm);
	},

	invoices_remove(frm) {
		set_totals(frm);
	},
});

function set_intro(frm) {
	const state = frm.doc.workflow_state;

	if (frm.doc.docstatus === 1 && frm.doc.payment_status !== "Paid") {
		frm.set_intro(
			__(
				"Payment Entries are created as drafts with this proposal's number as the reference. " +
					"Replace it with the cheque / EFT number, then submit each one."
			),
			"blue"
		);
	} else if (state === "Pending Approval") {
		frm.set_intro(__("Waiting for approval. Amounts can still be lowered before approving."), "orange");
	} else if (state === "Rejected" && frm.doc.rejection_reason) {
		frm.set_intro(__("Rejected: {0}", [frm.doc.rejection_reason]), "red");
	}
}

function set_totals(frm) {
	const rows = frm.doc.invoices || [];
	frm.set_value(
		"total_amount",
		rows.reduce((sum, row) => sum + flt(row.amount_to_pay), 0)
	);
	frm.set_value("invoice_count", rows.length);
	frm.set_value("supplier_count", new Set(rows.map((row) => row.supplier).filter(Boolean)).size);
}

function get_unpaid_invoices(frm) {
	if (!frm.doc.company || !frm.doc.paid_from_account_currency) {
		frappe.msgprint(__("Select the Company and Pay From account first."));
		return;
	}

	const dialog = new frappe.ui.Dialog({
		title: __("Get Unpaid Invoices"),
		fields: [
			{
				fieldname: "supplier",
				fieldtype: "Link",
				options: "Supplier",
				label: __("Supplier"),
				description: __("Leave blank for all suppliers."),
			},
			{
				fieldname: "due_on_or_before",
				fieldtype: "Date",
				label: __("Due On or Before"),
				default: frm.doc.payment_date,
			},
		],
		primary_action_label: __("Get Invoices"),
		primary_action(values) {
			frappe
				.call(`${SPP_METHOD}.get_unpaid_invoices`, {
					company: frm.doc.company,
					currency: frm.doc.paid_from_account_currency,
					proposal: frm.is_new() ? null : frm.doc.name,
					...values,
				})
				.then((r) => {
					const existing = new Set((frm.doc.invoices || []).map((row) => row.purchase_invoice));
					const invoices = (r.message || []).filter((pi) => !existing.has(pi.purchase_invoice));

					invoices.forEach((pi) => {
						const row = frm.add_child("invoices");
						[
							"purchase_invoice",
							"supplier",
							"supplier_name",
							"bill_no",
							"posting_date",
							"due_date",
							"currency",
							"party_account",
							"grand_total",
							"outstanding_amount",
							"amount_to_pay",
						].forEach((field) => (row[field] = pi[field]));
					});

					frm.refresh_field("invoices");
					set_totals(frm);
					dialog.hide();
					frappe.show_alert({
						message: __("{0} invoice(s) added", [invoices.length]),
						indicator: invoices.length ? "green" : "orange",
					});
				});
		},
	});
	dialog.show();
}

function create_payment_entries(frm) {
	frappe.confirm(
		__("Create one draft Payment Entry per supplier for the approved amounts?"),
		() => {
			frm.call({
				doc: frm.doc,
				method: "create_payment_entries",
				freeze: true,
				freeze_message: __("Creating Payment Entries..."),
			}).then((r) => {
				const { created = [], failed = [] } = r.message || {};
				const lines = created.map(
					(d) =>
						`${frappe.utils.get_form_link("Payment Entry", d.payment_entry, true)}: ${frappe.utils.escape_html(d.supplier)}, ${format_currency(d.amount, frm.doc.paid_from_account_currency)}`
				);
				failed.forEach((d) =>
					lines.push(
						`<span class="text-danger">${frappe.utils.escape_html(d.supplier)}: ${d.error}</span>`
					)
				);

				frappe.msgprint({
					title: failed.length ? __("Some Payment Entries failed") : __("Payment Entries Created"),
					message: lines.join("<br>"),
					indicator: failed.length ? "orange" : "green",
				});
				frm.reload_doc();
			});
		}
	);
}
