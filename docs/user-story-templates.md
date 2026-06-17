This structure maintains the user-centric focus of agile while adding supporting sections for completeness and traceability.

## Enhanced User Story Structure for Agile Teams

### 1. Story ID
*Unique identifier for tracking (e.g., US-101).*

### 2. Story Title
*Short, descriptive name (e.g., "User Password Reset").*

### 3. User Story Statement
*The classic agile format:*
> **As a** [user/role], **I want** [goal/action], **so that** [benefit/value].

### 4. Description / Context
*Additional context, background, or business rationale for the story.*

### 5. Acceptance Criteria
*Clear, testable conditions that define when the story is complete (often written as "Given/When/Then" scenarios).*

### 6. User Interface / Design References (if applicable)
*Links to wireframes, mockups, or design specifications.*

### 7. Dependencies
*Other stories, tasks, or systems this story depends on.*

### 8. Notes / Constraints
*Special considerations, technical notes, or limitations.*

### 9. Out of Scope
*What is explicitly not included in this story.*

### 10. Priority / Value
*Relative importance or business value (optional, but useful for backlog grooming).*

## Example

**Story ID:** US-101  
**Story Title:** Reset Forgotten Password  
**User Story:**  
> As a registered user, I want to reset my forgotten password so that I can regain access to my account.

**Description:**  
Users sometimes forget their passwords and need a secure way to reset them without contacting support.

**Acceptance Criteria:**  
- Given I am on the login page, when I click "Forgot Password," I am prompted to enter my email address.
- When I submit my email, I receive a password reset link if my email is registered.
- The reset link expires after 1 hour.
- If the email is not registered, I see a generic error message.

**UI/Design References:**  
- [Figma Link to Reset Password Flow](#)

**Dependencies:**  
- Email service integration

**Notes/Constraints:**  
- Must comply with company security policies
- No password hints allowed

**Out of Scope:**  
- Reset via SMS

**Priority:** High

## Why This Structure Works

- **User-focused:** Keeps the user and their goals at the center.
- **Clear and testable:** Acceptance criteria make it easy to verify completion.
- **Flexible:** Additional sections provide context without overwhelming the core story.
- **Traceable:** IDs, dependencies, and notes help with project management and implementation.

**Tip:**  
For technical stories (e.g., API endpoints), you can add a technical task or sub-task linked to the user story, where you document inputs, outputs, and error codes in detail—keeping the main story user-centric and agile-compliant.

Let me know if you’d like an example tailored to a specific domain (e.g., web app, API, mobile)!