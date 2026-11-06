import frappe

from crystal_custom.setup import set_workflow_email_states, setup_supplier_payment_advice


def execute():
    setup_supplier_payment_advice()
    set_workflow_email_states()
    drop_old_series_override()


def drop_old_series_override():
    """Stop the old SPP- series overriding the new SPA- one.

    When a doctype with records is synced, Frappe keeps its previous series in
    a Property Setter, so this has to run after model sync. Existing records
    keep their SPP- names. Exact match only, so a series a site has customised
    is left alone.
    """
    frappe.db.delete(
        "Property Setter",
        {
            "doc_type": "Supplier Payment Advice",
            "field_name": "naming_series",
            "property": "options",
            "value": "SPP-.YYYY.-",
        },
    )
    frappe.clear_cache(doctype="Supplier Payment Advice")
