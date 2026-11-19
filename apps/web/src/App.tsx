import { BrowserRouter, Route, Routes } from "react-router-dom";
import { PublicShell, RoleGate, SignedInLayout } from "./components/Layout";
import { AuthProvider } from "./lib/auth";
import { BookingsPage } from "./pages/Bookings";
import { EmployerJobDetail } from "./pages/EmployerJobDetail";
import { EmployerJobs } from "./pages/EmployerJobs";
import { EmployerProfile } from "./pages/EmployerProfile";
import { Credits } from "./pages/Credits";
import { ForgotPassword } from "./pages/ForgotPassword";
import { Landing } from "./pages/Landing";
import { ResetPassword } from "./pages/ResetPassword";
import { Login } from "./pages/Login";
import { NewJob } from "./pages/NewJob";
import { NewJobAi } from "./pages/NewJobAi";
import { NotFound } from "./pages/NotFound";
import { NotificationsPage } from "./pages/Notifications";
import { Signup } from "./pages/Signup";
import { WorkerApplications } from "./pages/WorkerApplications";
import { WorkerJobDetail } from "./pages/WorkerJobDetail";
import { WorkerJobs } from "./pages/WorkerJobs";
import { WorkerProfilePage } from "./pages/WorkerProfile";

/** Route table (exported separately so tests can render it inside a MemoryRouter). */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<PublicShell />}>
        <Route index element={<Landing />} />
        <Route path="login" element={<Login />} />
        <Route path="signup" element={<Signup />} />
        <Route path="forgot-password" element={<ForgotPassword />} />
        <Route path="reset-password" element={<ResetPassword />} />
        <Route path="credits" element={<Credits />} />
      </Route>

      <Route element={<SignedInLayout />}>
        <Route element={<RoleGate role="worker" />}>
          <Route path="worker" element={<WorkerJobs />} />
          <Route path="worker/jobs/:id" element={<WorkerJobDetail />} />
          <Route path="worker/applications" element={<WorkerApplications />} />
          <Route path="worker/bookings" element={<BookingsPage role="worker" />} />
          <Route path="worker/profile" element={<WorkerProfilePage />} />
        </Route>
        <Route element={<RoleGate role="employer" />}>
          <Route path="employer" element={<EmployerJobs />} />
          <Route path="employer/jobs/new" element={<NewJob />} />
          <Route path="employer/jobs/new/ai" element={<NewJobAi />} />
          <Route path="employer/jobs/:id" element={<EmployerJobDetail />} />
          <Route path="employer/bookings" element={<BookingsPage role="employer" />} />
          <Route path="employer/profile" element={<EmployerProfile />} />
        </Route>
        <Route path="notifications" element={<NotificationsPage />} />
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
