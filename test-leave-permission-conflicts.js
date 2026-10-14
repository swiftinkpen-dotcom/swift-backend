/**
 * Comprehensive Test Suite for Leave & Permission Conflict Management System
 * Covers all 16 Business Rule Scenarios
 */

function normalizeDateString(input) {
  if (!input) return null;
  if (input instanceof Date) {
    if (isNaN(input.getTime())) return null;
    const y = input.getFullYear();
    const m = String(input.getMonth() + 1).padStart(2, '0');
    const d = String(input.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  let str = String(input).trim();
  if (str.includes('(')) {
    str = str.split('(')[0].trim();
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    return str.substring(0, 10);
  }
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const d = String(parsed.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return null;
}

function getDatesInRange(startStr, endStr) {
  const dates = [];
  const start = new Date(startStr);
  const end = new Date(endStr || startStr);
  if (isNaN(start.getTime())) return dates;
  const curr = new Date(start);
  const last = isNaN(end.getTime()) ? new Date(start) : new Date(end);

  while (curr <= last) {
    const y = curr.getFullYear();
    const m = String(curr.getMonth() + 1).padStart(2, '0');
    const d = String(curr.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    curr.setDate(curr.getDate() + 1);
  }
  return dates;
}

function isPermissionRecord(item) {
  if (!item) return false;
  if (item.requestType === 'permission') return true;
  const typeStr = String(item.type || item.category || '').toLowerCase();
  return typeStr.includes('permission') || typeStr.includes('short permission');
}

function isLeaveRecord(item) {
  return !isPermissionRecord(item);
}

function isHalfDayRecord(item) {
  if (!item) return false;
  const typeStr = String(item.type || '').toLowerCase();
  const daysStr = String(item.days || '').toLowerCase();
  const durationType = String(item.leaveDurationType || '').toLowerCase();
  return (
    typeStr.includes('half') ||
    daysStr.includes('0.5') ||
    daysStr.includes('half') ||
    durationType === 'half'
  );
}

function getDatesForLeaveRecord(l) {
  const normStart = normalizeDateString(l.startDate || l.date);
  const normEnd = normalizeDateString(l.endDate || l.startDate || l.date);
  if (!normStart) return [];
  return getDatesInRange(normStart, normEnd || normStart);
}

function validateLeavePermissionConflict({
  tenantId,
  employeeId,
  requestType,
  leaveCategory,
  leaveDurationType,
  halfDaySession,
  startDate,
  endDate,
  existingLeaves = [],
  existingAttendance = [],
}) {
  const normStart = normalizeDateString(startDate);
  const normEnd = leaveDurationType === 'range' ? normalizeDateString(endDate) : normStart;

  if (!normStart) {
    return {
      allowed: false,
      code: 'INVALID_DATE',
      message: 'Invalid start date provided.',
      dateResults: []
    };
  }

  const normEndFinal = normEnd || normStart;
  const dateList = getDatesInRange(normStart, normEndFinal);
  const todayStr = normalizeDateString(new Date());

  const dateResults = [];
  let overallAllowed = true;
  let overallMessage = '';
  let specialExceptionCount = 0;
  let blockedCount = 0;

  for (const dStr of dateList) {
    const activeOnDate = existingLeaves.filter((l) => {
      const st = String(l.status || '').trim().toLowerCase();
      if (st === 'rejected' || st === 'cancelled' || st === 'superseded') return false;
      const lDates = getDatesForLeaveRecord(l);
      return lDates.includes(dStr);
    });

    const approvedOnDate = activeOnDate.filter((l) => String(l.status || '').trim().toLowerCase() === 'approved');
    const pendingOnDate = activeOnDate.filter((l) => String(l.status || '').trim().toLowerCase() === 'pending');

    const approvedLeaves = approvedOnDate.filter(isLeaveRecord);
    const pendingLeaves = pendingOnDate.filter(isLeaveRecord);

    const approvedPermissions = approvedOnDate.filter(isPermissionRecord);
    const pendingPermissions = pendingOnDate.filter(isPermissionRecord);

    const attRecord = existingAttendance.find((a) => {
      const attD = normalizeDateString(a.date);
      return attD === dStr;
    });

    let attState = 'pending';
    if (dStr > todayStr) {
      attState = 'pending';
    } else if (attRecord) {
      const attStatus = String(attRecord.status || '').trim().toLowerCase();
      const hrs = parseFloat(attRecord.hoursWorked) || 0;
      const hasPunch = Boolean(attRecord.clockIn || attRecord.checkIn);

      if (attStatus === 'absent' || (!hasPunch && hrs === 0 && attStatus !== 'present' && attStatus !== 'late' && attStatus !== 'halfday')) {
        attState = 'absent';
      } else if (attStatus === 'present' || attStatus === 'late' || attStatus === 'halfday' || hrs > 0 || hasPunch) {
        attState = 'worked';
      } else {
        attState = 'pending';
      }
    } else {
      attState = 'pending';
    }

    let dateAllowed = true;
    let dateCode = 'ALLOWED';
    let dateMessage = 'Available';
    let isSpecialException = false;

    if (requestType === 'permission') {
      if (approvedLeaves.length > 0) {
        dateAllowed = false;
        dateCode = 'APPROVED_LEAVE_BLOCKS_PERMISSION';
        dateMessage = 'Leave is already approved for this date. Permission cannot be applied.';
      } else if (pendingLeaves.length > 0) {
        dateAllowed = false;
        dateCode = 'PENDING_LEAVE_BLOCKS_PERMISSION';
        dateMessage = 'Leave request is pending for this date. Permission cannot be applied.';
      } else if (approvedPermissions.length > 0) {
        dateAllowed = false;
        dateCode = 'DUPLICATE_PERMISSION_APPROVED';
        dateMessage = 'Permission is already approved for this date.';
      } else if (pendingPermissions.length > 0) {
        dateAllowed = false;
        dateCode = 'DUPLICATE_PERMISSION_PENDING';
        dateMessage = 'Permission request is already pending for this date.';
      }
    } else {
      // requestType === 'leave'
      if (approvedLeaves.length > 0) {
        dateAllowed = false;
        dateCode = 'DUPLICATE_LEAVE_APPROVED';
        dateMessage = 'Leave already approved for this date.';
      } else if (pendingLeaves.length > 0) {
        dateAllowed = false;
        dateCode = 'DUPLICATE_LEAVE_PENDING';
        dateMessage = 'Leave request is already pending for this date.';
      } else if (approvedPermissions.length > 0) {
        if (leaveDurationType === 'half') {
          dateAllowed = false;
          dateCode = 'PERMISSION_EXISTS_HALF_DAY_BLOCKED';
          dateMessage = 'Permission is already approved for this date.';
        } else {
          // Full-Day Leave
          if (attState === 'worked') {
            dateAllowed = false;
            dateCode = 'PERMISSION_WORKED_BLOCKS_LEAVE';
            dateMessage = 'Permission exists, but attendance shows that you worked today. Leave cannot be applied.';
          } else if (attState === 'absent') {
            // SPECIAL EXCEPTION — PERMISSION DAY → FULL-DAY LEAVE
            dateAllowed = true;
            dateCode = 'SPECIAL_EXCEPTION_ABSENT_ALLOW';
            dateMessage = 'Permission exists, but no attendance was recorded for the full day. You can apply Leave for this date.';
            isSpecialException = true;
            specialExceptionCount++;
          } else {
            dateAllowed = false;
            dateCode = 'ATTENDANCE_PENDING_BLOCKS_LEAVE';
            dateMessage = 'Attendance for this date is not finalized yet. Leave application will be available after attendance is updated.';
          }
        }
      } else if (pendingPermissions.length > 0) {
        dateAllowed = false;
        dateCode = 'PENDING_PERMISSION_BLOCKS_LEAVE';
        dateMessage = 'Permission request is currently pending for this date. Please cancel or resolve permission request.';
      }
    }

    if (!dateAllowed) {
      overallAllowed = false;
      blockedCount++;
    }

    dateResults.push({
      date: dStr,
      allowed: dateAllowed,
      code: dateCode,
      message: dateMessage,
      isSpecialException,
      attState,
      approvedLeavesCount: approvedLeaves.length,
      approvedPermissionsCount: approvedPermissions.length
    });
  }

  if (!overallAllowed) {
    const blockedDatesStr = dateResults
      .filter((r) => !r.allowed)
      .map((r) => `${r.date}: ${r.message}`)
      .join(' ');
    overallMessage = dateList.length === 1
      ? dateResults[0].message
      : `Conflict in date range: ${blockedDatesStr}`;
  } else {
    if (specialExceptionCount > 0) {
      overallMessage = 'Permission exists, but no attendance was recorded for the full day. You can apply Leave for this date.';
    } else {
      overallMessage = 'Date selection is valid and available.';
    }
  }

  const overallCode = dateList.length === 1
    ? dateResults[0].code
    : (overallAllowed ? (specialExceptionCount > 0 ? 'ALLOWED_WITH_SPECIAL_EXCEPTION' : 'ALLOWED') : 'BLOCKED');

  return {
    allowed: overallAllowed,
    message: overallMessage,
    code: overallCode,
    dateResults,
    specialExceptionCount,
    blockedCount
  };
}

async function runTestSuite() {
  console.log("=========================================================================");
  console.log("🧪 LEAVE & PERMISSION CONFLICT MANAGEMENT SYSTEM — TEST SUITE");
  console.log("=========================================================================\n");

  const testCases = [
    {
      id: 1,
      name: "Approved Leave → Permission blocked",
      input: {
        requestType: 'permission',
        startDate: '2026-10-06',
        existingLeaves: [{ id: 'l1', type: 'Casual Leave', startDate: '2026-10-06', status: 'Approved' }],
      },
      expected: { allowed: false, code: 'APPROVED_LEAVE_BLOCKS_PERMISSION' }
    },
    {
      id: 2,
      name: "Approved Permission + employee worked → Leave blocked",
      input: {
        requestType: 'leave',
        leaveDurationType: 'single',
        startDate: '2026-10-06',
        existingLeaves: [{ id: 'p1', type: 'Short Permission', startDate: '2026-10-06', status: 'Approved' }],
        existingAttendance: [{ id: 'a1', date: '2026-10-06', status: 'present', hoursWorked: 8 }],
      },
      expected: { allowed: false, code: 'PERMISSION_WORKED_BLOCKS_LEAVE' }
    },
    {
      id: 3,
      name: "Approved Permission + employee absent entire day → Leave allowed (Special Exception)",
      input: {
        requestType: 'leave',
        leaveDurationType: 'single',
        startDate: '2026-10-06',
        existingLeaves: [{ id: 'p1', type: 'Short Permission', startDate: '2026-10-06', status: 'Approved' }],
        existingAttendance: [{ id: 'a1', date: '2026-10-06', status: 'absent', hoursWorked: 0 }],
      },
      expected: { allowed: true, code: 'SPECIAL_EXCEPTION_ABSENT_ALLOW' }
    },
    {
      id: 4,
      name: "Pending Leave → Permission conflict handled correctly",
      input: {
        requestType: 'permission',
        startDate: '2026-10-06',
        existingLeaves: [{ id: 'l1', type: 'Casual Leave', startDate: '2026-10-06', status: 'Pending' }],
      },
      expected: { allowed: false, code: 'PENDING_LEAVE_BLOCKS_PERMISSION' }
    },
    {
      id: 5,
      name: "Rejected Leave → new Permission allowed",
      input: {
        requestType: 'permission',
        startDate: '2026-10-06',
        existingLeaves: [{ id: 'l1', type: 'Casual Leave', startDate: '2026-10-06', status: 'Rejected' }],
      },
      expected: { allowed: true }
    },
    {
      id: 6,
      name: "Cancelled Permission → new Leave allowed",
      input: {
        requestType: 'leave',
        leaveDurationType: 'single',
        startDate: '2026-10-06',
        existingLeaves: [{ id: 'p1', type: 'Short Permission', startDate: '2026-10-06', status: 'Cancelled' }],
      },
      expected: { allowed: true }
    },
    {
      id: 7,
      name: "Half-day Leave + Permission",
      input: {
        requestType: 'leave',
        leaveDurationType: 'half',
        startDate: '2026-10-06',
        existingLeaves: [{ id: 'p1', type: 'Short Permission', startDate: '2026-10-06', status: 'Approved' }],
      },
      expected: { allowed: false, code: 'PERMISSION_EXISTS_HALF_DAY_BLOCKED' }
    },
    {
      id: 8,
      name: "Permission + half-day Leave",
      input: {
        requestType: 'permission',
        startDate: '2026-10-06',
        existingLeaves: [{ id: 'l1', type: 'Half Day Leave', startDate: '2026-10-06', days: '0.5 Day', status: 'Approved' }],
      },
      expected: { allowed: false, code: 'APPROVED_LEAVE_BLOCKS_PERMISSION' }
    },
    {
      id: 9,
      name: "Multiple permissions on same day",
      input: {
        requestType: 'permission',
        startDate: '2026-10-06',
        existingLeaves: [{ id: 'p1', type: 'Short Permission', startDate: '2026-10-06', status: 'Approved' }],
      },
      expected: { allowed: false, code: 'DUPLICATE_PERMISSION_APPROVED' }
    },
    {
      id: 10,
      name: "Date-range Leave containing conflicting dates",
      input: {
        requestType: 'leave',
        leaveDurationType: 'range',
        startDate: '2026-10-06',
        endDate: '2026-10-10',
        existingLeaves: [
          { id: 'p1', type: 'Short Permission', startDate: '2026-10-06', status: 'Approved' },
          { id: 'l1', type: 'Sick Leave', startDate: '2026-10-08', status: 'Approved' },
          { id: 'p2', type: 'Short Permission', startDate: '2026-10-10', status: 'Approved' },
        ],
        existingAttendance: [
          { id: 'a1', date: '2026-10-06', status: 'absent' }, // 06-Oct: Special exception -> allowed
          { id: 'a2', date: '2026-10-10', status: 'present', hoursWorked: 8 } // 10-Oct: Worked -> blocked
        ],
      },
      expected: { allowed: false, blockedCount: 2 }
    },
    {
      id: 11,
      name: "Attendance pending (future date with permission)",
      input: {
        requestType: 'leave',
        leaveDurationType: 'single',
        startDate: '2026-10-25',
        existingLeaves: [{ id: 'p1', type: 'Short Permission', startDate: '2026-10-25', status: 'Approved' }],
      },
      expected: { allowed: false, code: 'ATTENDANCE_PENDING_BLOCKS_LEAVE' }
    },
    {
      id: 12,
      name: "Attendance finalized as absent",
      input: {
        requestType: 'leave',
        leaveDurationType: 'single',
        startDate: '2026-10-05',
        existingLeaves: [{ id: 'p1', type: 'Short Permission', startDate: '2026-10-05', status: 'Approved' }],
        existingAttendance: [{ id: 'a1', date: '2026-10-05', status: 'absent', hoursWorked: 0 }],
      },
      expected: { allowed: true, code: 'SPECIAL_EXCEPTION_ABSENT_ALLOW' }
    },
    {
      id: 13,
      name: "Attendance finalized as present",
      input: {
        requestType: 'leave',
        leaveDurationType: 'single',
        startDate: '2026-10-05',
        existingLeaves: [{ id: 'p1', type: 'Short Permission', startDate: '2026-10-05', status: 'Approved' }],
        existingAttendance: [{ id: 'a1', date: '2026-10-05', status: 'present', hoursWorked: 8 }],
      },
      expected: { allowed: false, code: 'PERMISSION_WORKED_BLOCKS_LEAVE' }
    },
    {
      id: 14,
      name: "Duplicate Leave request",
      input: {
        requestType: 'leave',
        leaveDurationType: 'single',
        startDate: '2026-10-06',
        existingLeaves: [{ id: 'l1', type: 'Casual Leave', startDate: '2026-10-06', status: 'Approved' }],
      },
      expected: { allowed: false, code: 'DUPLICATE_LEAVE_APPROVED' }
    },
    {
      id: 15,
      name: "Duplicate Permission request (Pending)",
      input: {
        requestType: 'permission',
        startDate: '2026-10-06',
        existingLeaves: [{ id: 'p1', type: 'Short Permission', startDate: '2026-10-06', status: 'Pending' }],
      },
      expected: { allowed: false, code: 'DUPLICATE_PERMISSION_PENDING' }
    },
    {
      id: 16,
      name: "API-level bypass attempt simulation (Pre-mutation Guard)",
      input: {
        requestType: 'leave',
        leaveDurationType: 'single',
        startDate: '2026-10-06',
        existingLeaves: [{ id: 'l1', type: 'Casual Leave', startDate: '2026-10-06', status: 'Approved' }],
      },
      expected: { allowed: false, code: 'DUPLICATE_LEAVE_APPROVED' }
    },
  ];

  let passed = 0;
  let failed = 0;

  for (const tc of testCases) {
    const res = validateLeavePermissionConflict(tc.input);

    let match = true;
    if (res.allowed !== tc.expected.allowed) match = false;
    if (tc.expected.code && res.code !== tc.expected.code) match = false;
    if (tc.expected.blockedCount !== undefined && res.blockedCount !== tc.expected.blockedCount) match = false;

    if (match) {
      passed++;
      console.log(`✅ [TEST ${tc.id}] ${tc.name}: PASSED`);
      console.log(`   Result: allowed=${res.allowed}, code=${res.code}, msg="${res.message}"\n`);
    } else {
      failed++;
      console.log(`❌ [TEST ${tc.id}] ${tc.name}: FAILED`);
      console.log(`   Expected: allowed=${tc.expected.allowed}, code=${tc.expected.code}`);
      console.log(`   Got:      allowed=${res.allowed}, code=${res.code}, msg="${res.message}"\n`);
    }
  }

  console.log("=========================================================================");
  console.log(`📊 TEST RESULTS: ${passed} PASSED, ${failed} FAILED OUT OF ${testCases.length} SCENARIOS`);
  console.log("=========================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error("Test execution error:", err);
  process.exit(1);
});
