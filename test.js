/**
 * n8n Function node: VM request -> Semaphore run(s)
 *
 * Expands one Frappe VM request into one or more Semaphore template runs.
 *
 * Routing is data-driven. A lookup table keyed by
 *   (requestor_role, academic_purpose, user_scope, for_project, deploy_a_vm_for_myself)
 * returns an ordered list of run specs. Each spec is a complete declaration of
 * what one Semaphore run looks like; the builder only substitutes values.
 *
 * Add a new behavior = add a row to ROUTES, never touch buildRun().
 */

// ============================================================================
// Constants
// ============================================================================

const SEMAPHORE_TEMPLATE_PROD  = 4;
const SEMAPHORE_TEMPLATE_VCSIM = 6;

// Scope aliases received from upstream (Frappe) -> canonical scope used here.
const SCOPE_ALIASES = {
  single_user_ded: 'single_user_dedicated',
};

// ============================================================================
// Input parsing
// ============================================================================

const item    = $input.item.json;
//const envName = $('On VM Request Submission').first().json.body.environment;
//const isVcsim = envName === 'vcsim';
const isVcsim = 1;

const meta     = safeJsonParse(item.provisioning_metadata, {});
const students = safeJsonParse(item.students, []);

const ctx = {
  // Identity
  requestor:           item.requestor,
  requestorUsername:   item.requestor_username,
  requestorRole:       titleCase(item.requestor_role || ''),

  // Classification
  purpose:             (item.academic_purpose || '').toLowerCase(),
  scope:               SCOPE_ALIASES[item.user_scope] || item.user_scope,
  forProject:          Number(item.for_project) === 1,
  deployForMyself:     Number(meta.deploy_a_vm_for_myself) === 1,

  // Counts
  reqTotal:            Number(item.req_total_vm_count)   || 0,
  reqStudent:          Number(item.req_student_vm_count) || 0,
  reqFaculty:          Number(item.req_faculty_vm_count) || 0,

  // Naming inputs
  template:            item.template,
  course:              item.course || meta.course || '',
  section:             item.sec_number || meta.section || '',
  termMnemonic:        item.term_mnemonic || '',
  projectName:         item.project_name || meta.project_name || null,

  // Principals
  instructorUsernames: (meta.instructor_usernames && meta.instructor_usernames.length)
    ? meta.instructor_usernames
    : [item.requestor_username],
  studentUsernames:    students.map(s => s.username).filter(Boolean),
};

// ============================================================================
// Routing table
// ============================================================================
//
// Spec shape:
//   {
//     userScope:            output user_scope for the playbook
//     deployMode:           'single' | 'batch'
//     destination:          'EMPLOYEES' | 'STUDENTS' | 'LABS' | 'PROJECTS'
//     access:               'faculty_only' | 'student_faculty'
//     basename:             'instructor' | 'course' | 'student' | 'student_personal' | 'project'
//     count:                'req_total' | 'req_student' | 'req_faculty' | <number>
//     moveToStudentFolders: boolean
//   }
//
// Key shape: "Role:purpose:scope:forProject:deployForMyself"
// Use '*' for "any value" on the for_project / deploy_for_myself dimensions.
// More specific keys win over wildcards (see candidateKeys() ordering).

const STUDENT_BATCH = {
  userScope:            'per_student_vm',
  deployMode:           'batch',
  destination:          'STUDENTS',          // staged in LABS, mover relocates per student
  access:               'student_faculty',
  basename:             'course',
  count:                'req_student',
  moveToStudentFolders: true,
};

const INSTRUCTOR_SINGLE = {
  userScope:            'instructor_vm',
  deployMode:           'single',
  destination:          'EMPLOYEES',
  access:               'faculty_only',
  basename:             'instructor',
  count:                'req_faculty',
  moveToStudentFolders: false,
};

const SHARED_LABS = {
  userScope:            'shared_vm',
  deployMode:           'batch',
  destination:          'LABS',
  access:               'student_faculty',
  basename:             'course',
  count:                'req_total',
  moveToStudentFolders: false,
};

const SHARED_PROJECTS = {
  userScope:            'shared_vm',
  deployMode:           'batch',
  destination:          'PROJECTS',
  access:               'student_faculty',
  basename:             'project',
  count:                'req_total',
  moveToStudentFolders: false,
};

const ROUTES = {
  // ---------------- Faculty / instructional ----------------
  'Faculty:instructional:single_user_dedicated:*:*': [
    { ...INSTRUCTOR_SINGLE, userScope: 'single_user_dedicated', count: 'req_total' },
  ],

  'Faculty:instructional:per_student_vm:false:false': [STUDENT_BATCH],
  'Faculty:instructional:per_student_vm:false:true':  [STUDENT_BATCH, INSTRUCTOR_SINGLE],
  'Faculty:instructional:per_student_vm:true:false':  [
    { ...STUDENT_BATCH, destination: 'PROJECTS', moveToStudentFolders: false },
  ],
  'Faculty:instructional:per_student_vm:true:true': [
    { ...STUDENT_BATCH,      destination: 'PROJECTS', moveToStudentFolders: false },
    { ...INSTRUCTOR_SINGLE,  destination: 'PROJECTS' },
  ],

  'Faculty:instructional:shared_vm:false:*': [SHARED_LABS],
  'Faculty:instructional:shared_vm:true:*':  [SHARED_PROJECTS],

  'Faculty:instructional:instructor_vm:false:*': [
    { ...INSTRUCTOR_SINGLE, count: 'req_total' },
  ],
  'Faculty:instructional:instructor_vm:true:*': [
    { ...INSTRUCTOR_SINGLE, destination: 'PROJECTS', count: 'req_total' },
  ],

  // ---------------- Faculty / research ---------------------
  // CSV row 11: project flag implicit-1, scope irrelevant -> PROJECTS, faculty+students.
  'Faculty:research:*:*:*': [SHARED_PROJECTS],

  // ---------------- Faculty / extracurricular --------------
  'Faculty:extracurricular:single_user_dedicated:*:*': [
    { ...INSTRUCTOR_SINGLE, userScope: 'single_user_dedicated', count: 'req_total' },
  ],
  'Faculty:extracurricular:shared_vm:false:*': [SHARED_LABS],
  'Faculty:extracurricular:shared_vm:true:*':  [SHARED_PROJECTS],

  // ---------------- Student --------------------------------
  // Self-request for a course VM.
  'Student:instructional:self_req_student_course_vm:false:*': [{
    userScope:            'self_req_student_course_vm',
    deployMode:           'batch',
    destination:          'STUDENTS',
    access:               'student_faculty',
    basename:             'student',
    count:                'req_total',
    moveToStudentFolders: true,
  }],
  'Student:instructional:self_req_student_course_vm:true:*': [{
    userScope:            'self_req_student_course_vm',
    deployMode:           'batch',
    destination:          'PROJECTS',
    access:               'student_faculty',
    basename:             'project',
    count:                'req_total',
    moveToStudentFolders: false,
  }],

  // Student requesting their own personal VM.
  'Student:*:single_user_dedicated:*:*': [{
    userScope:            'single_user_dedicated',
    deployMode:           'single',
    destination:          'STUDENTS',
    access:               'student_faculty',
    basename:             'student_personal',
    count:                'req_total',
    moveToStudentFolders: true,
  }],
};

// ============================================================================
// Route resolution
// ============================================================================

function candidateKeys(c) {
  const fp = String(c.forProject);
  const dm = String(c.deployForMyself);
  const role = c.requestorRole;
  const pur  = c.purpose;
  const scp  = c.scope;
  return [
    `${role}:${pur}:${scp}:${fp}:${dm}`,
    `${role}:${pur}:${scp}:${fp}:*`,
    `${role}:${pur}:${scp}:*:${dm}`,
    `${role}:${pur}:${scp}:*:*`,
    `${role}:${pur}:*:${fp}:${dm}`,
    `${role}:${pur}:*:${fp}:*`,
    `${role}:${pur}:*:*:${dm}`,
    `${role}:${pur}:*:*:*`,
    `${role}:*:${scp}:${fp}:${dm}`,
    `${role}:*:${scp}:*:*`,
    `${role}:*:*:*:*`,
  ];
}

function resolveRoute(c) {
  for (const key of candidateKeys(c)) {
    if (ROUTES[key]) return { matchedKey: key, specs: ROUTES[key] };
  }
  throw new Error(
    `No routing match for role="${c.requestorRole}" purpose="${c.purpose}" ` +
    `scope="${c.scope}" for_project=${c.forProject} deploy_for_myself=${c.deployForMyself}`
  );
}

// ============================================================================
// Run builder (pure substitution)
// ============================================================================

// VM basename style: uppercased, spaces stripped, trailing dash.
//   "CSC 155" + "A" -> "CSC155-A-"
function courseBasename(c) {
  const courseCompact = (c.course || '').toUpperCase().replace(/\s+/g, '');
  const sectionUpper  = (c.section || '').toUpperCase();
  return `${courseCompact}-${sectionUpper}-`;
}

// vSphere folder slug: lowercased, spaces preserved.
//   "CSC 155" + "A" -> "csc 155-a"
function courseFolderSlug(c) {
  return `${c.course}-${c.section}`.toLowerCase();
}

function basenameFor(type, c) {
  switch (type) {
    case 'course':           return courseBasename(c);
    case 'instructor':       return `${c.instructorUsernames[0]}-vm`;
    case 'student':          return `${courseBasename(c)}${c.requestorUsername}-vm`;
    case 'student_personal': return `${c.requestorUsername}-vm`;
    case 'project':          return c.projectName || courseBasename(c);
    default:
      throw new Error(`Unknown basename type: ${type}`);
  }
}

function destinationFor(dest, c) {
  switch (dest) {
    case 'EMPLOYEES': return `EMPLOYEES/${c.instructorUsernames[0]}`;
    case 'LABS':      return `LABS/${courseFolderSlug(c)}`;
    case 'STUDENTS':  return `LABS/${courseFolderSlug(c)}`;   // staged in LABS; mover relocates per student
    case 'PROJECTS':  return `PROJECTS/${c.projectName || courseFolderSlug(c)}`;
    default:
      throw new Error(`Unknown destination: ${dest}`);
  }
}

function countFor(source, c) {
  if (typeof source === 'number') return source;
  switch (source) {
    case 'req_total':   return c.reqTotal;
    case 'req_student': return c.reqStudent || c.reqTotal;
    case 'req_faculty': return c.reqFaculty || 1;
    default:
      throw new Error(`Unknown count source: ${source}`);
  }
}

function buildRun(spec, c) {
  const count            = countFor(spec.count, c);
  const includeStudents  = spec.access === 'student_faculty';

  const run = {
    deploy_mode:             spec.deployMode,
    user_scope:              spec.userScope,
    vm_basename:             basenameFor(spec.basename, c),
    template_name:           c.template,
    instructor_ids:          c.instructorUsernames,
    student_ids:             includeStudents ? c.studentUsernames : [],
    vm_start_number:         1,
    vm_deploy_count:         count,
    destination_path:        destinationFor(spec.destination, c),
    move_to_student_folders: spec.moveToStudentFolders,

    // Provenance fields kept for playbook backwards-compat. Remove once the
    // playbook reads exclusively from the canonical fields above.
    requestor:               c.requestor,
    requestor_username:      c.requestorUsername,
    req_total_vm_count:      count,
    term_code:               c.termMnemonic,
  };

  if (spec.userScope === 'per_student_vm' && c.studentUsernames.length > 0) {
    run.vms_per_student = Math.ceil(count / c.studentUsernames.length);
  } else if (spec.userScope === 'self_req_student_course_vm') {
    run.vms_per_student = count;
  }

  return run;
}

// ============================================================================
// Helpers
// ============================================================================

function safeJsonParse(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function titleCase(s) {
  return s.length ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
}

// ============================================================================
// Main
// ============================================================================

const { specs } = resolveRoute(ctx);
const runs      = specs.map(spec => buildRun(spec, ctx));
const templateId = isVcsim ? SEMAPHORE_TEMPLATE_VCSIM : SEMAPHORE_TEMPLATE_PROD;

return runs.map(run => {
  const envObj = { vm_request_data: run };
  if (isVcsim) {
    envObj.reserved_ips = Array.from(
      { length: run.vm_deploy_count || 1 },
      (_, i) => `10.99.1.${i + 1}`
    );
  }
  return {
    json: {
      template_id: templateId,
      environment: JSON.stringify(envObj),
    },
  };
});
