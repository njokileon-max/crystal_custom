import frappe

NEW = "Supplier Payment Advice"
NEW_FIELD = "custom_supplier_payment_advice"
OLD_NAMES = (
    ("Supplier Payment Proposal", "custom_supplier_payment_proposal"),
    ("Supplier Payment Advise", "custom_supplier_payment_advise"),
)


def execute():
    """Carry sites on an old name over, keeping their records.

    Must run before model sync, or sync would create empty new doctypes next
    to the old ones. Does nothing on sites that never had an old name.
    """
    for old, old_field in OLD_NAMES:
        if frappe.db.exists("DocType", old):
            rename(old, old_field)

    frappe.clear_cache()


def rename(old, old_field):
    # Replaced by the Approved and Rejected notifications in setup.py.
    if frappe.db.exists("Notification", f"{old} Status"):
        frappe.delete_doc("Notification", f"{old} Status", ignore_permissions=True, force=True)

    frappe.rename_doc("DocType", f"{old} Invoice", f"{NEW} Invoice", force=True)
    frappe.rename_doc("DocType", old, NEW, force=True)

    # Payment Entry's link field: rename the column along with its definition.
    old_custom_field = f"Payment Entry-{old_field}"
    if frappe.db.exists("Custom Field", old_custom_field):
        frappe.rename_doc("Custom Field", old_custom_field, f"Payment Entry-{NEW_FIELD}", force=True)
        frappe.db.set_value("Custom Field", f"Payment Entry-{NEW_FIELD}", "fieldname", NEW_FIELD)
        frappe.db.rename_column("Payment Entry", old_field, NEW_FIELD)

    if frappe.db.exists("Custom Field", f"{old}-workflow_state"):
        frappe.rename_doc("Custom Field", f"{old}-workflow_state", f"{NEW}-workflow_state", force=True)

    if frappe.db.exists("Workflow", f"{old} Approval"):
        frappe.rename_doc("Workflow", f"{old} Approval", f"{NEW} Approval", force=True)
